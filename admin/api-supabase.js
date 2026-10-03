// Real data layer: supabase-js (loaded as a UMD global) with Richard's login.
// Every query runs as the signed-in user, so row level security decides
// what comes back. Non-admins get empty results, not errors.

export function makeSupabaseApi({ supabaseUrl, supabaseAnonKey, businessTz }) {
  const sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  const LEAD_SELECT = '*, customer:customers(*), address:addresses(*)';

  return {
    demo: false,

    auth: {
      async session() {
        const { data } = await sb.auth.getSession();
        return data.session ? { email: data.session.user.email } : null;
      },
      onChange(cb) {
        sb.auth.onAuthStateChange((_event, session) => cb(session ? { email: session.user.email } : null));
      },
      async sendLink(email) {
        // shouldCreateUser: false — only accounts Jay created in the dashboard can sign in.
        must(await sb.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
        }));
      },
      async signOut() { await sb.auth.signOut(); },
      async isAdmin() { return must(await sb.rpc('is_admin')) === true; },
    },

    leads: {
      async list() {
        return must(await sb.from('quote_requests').select(LEAD_SELECT).order('created_at', { ascending: false }).limit(300));
      },
      async get(id) {
        const lead = must(await sb.from('quote_requests').select(LEAD_SELECT).eq('id', id).single());
        const [messages, job] = await Promise.all([
          sb.from('messages').select('*').eq('quote_id', id).order('created_at').then(must),
          sb.from('jobs').select('id').eq('quote_id', id).maybeSingle().then(must),
        ]);
        return { ...lead, messages, job_id: job?.id ?? null };
      },
      async setStatus(id, status) { must(await sb.from('quote_requests').update({ status }).eq('id', id)); },
    },

    jobs: {
      async board(fromDate, toDate) {
        return must(await sb.from('job_board').select('*').gte('scheduled_date', fromDate).lte('scheduled_date', toDate));
      },
      async get(id) {
        const job = must(await sb.from('jobs')
          .select('*, customer:customers(*), address:addresses(*), crew:crews(*), unit:units(*), items:job_items(*), quote:quote_requests(*)')
          .eq('id', id).single());
        job.items.sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
        return job;
      },
      async book({ quoteId, date, window, crewId, unitId }) {
        return must(await sb.rpc('book_quote', { p_quote_id: quoteId, p_date: date, p_window: window, p_crew: crewId || null, p_unit: unitId || null }));
      },
      async update(id, patch) { must(await sb.from('jobs').update(patch).eq('id', id)); },
      async complete(id) { return must(await sb.rpc('complete_job', { p_job_id: id, p_tz: businessTz })); },
    },

    items: {
      async add(jobId, item) { return must(await sb.from('job_items').insert({ ...item, job_id: jobId }).select().single()); },
      async update(id, patch) { must(await sb.from('job_items').update(patch).eq('id', id)); },
      async remove(id) { must(await sb.from('job_items').delete().eq('id', id)); },
    },

    addresses: {
      async update(id, patch) { must(await sb.from('addresses').update(patch).eq('id', id)); },
    },

    crews: {
      async list() { return must(await sb.from('crews').select('*').order('name')); },
      async add(row) { must(await sb.from('crews').insert(row)); },
      async update(id, patch) { must(await sb.from('crews').update(patch).eq('id', id)); },
    },

    units: {
      async list() { return must(await sb.from('units').select('*').order('unit_no')); },
      async add(row) { must(await sb.from('units').insert(row)); },
      async update(id, patch) { must(await sb.from('units').update(patch).eq('id', id)); },
    },

    priceBook: {
      async items() {
        return must(await sb.from('price_book').select('key, kind, label, amount_cents').eq('active', true).in('kind', ['addon', 'per_sqft']).order('sort'));
      },
    },
  };
}
