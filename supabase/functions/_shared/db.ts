// Postgres access for the edge functions. Uses the service role key, which
// Supabase injects into every edge function; it never reaches the browser.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { bookFromRows } from './pricing.js';

export function makeDb() {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const must = <T>(res: { data: T; error: unknown }): T => {
    if (res.error) throw res.error;
    return res.data;
  };

  async function activePromo(today: string, code?: string) {
    let q = sb.from('promo_codes').select('code, amount_cents, starts_on, ends_on')
      .eq('active', true).eq('online_only', true);
    if (code) q = q.eq('code', code);
    const rows = must(await q.order('created_at', { ascending: false }));
    // Dates are YYYY-MM-DD strings, so string comparison is date comparison.
    const live = (rows ?? []).find((r: { starts_on: string | null; ends_on: string | null }) =>
      (!r.starts_on || r.starts_on <= today) && (!r.ends_on || r.ends_on >= today));
    return live ? { code: String(live.code).toUpperCase(), amount_cents: live.amount_cents } : null;
  }

  async function logMessage(row: Record<string, unknown>) {
    const { error } = await sb.from('messages').insert(row);
    if (error) console.error('messages insert failed', error);
  }

  return {
    async loadPriceBook(today: string) {
      const rows = must(await sb.from('price_book').select('key, kind, label, amount_cents, includes, sort, active, updated_at').eq('active', true));
      const version = rows.reduce((m: string, r: { updated_at: string }) => (r.updated_at > m ? r.updated_at : m), '');
      return bookFromRows(rows, await activePromo(today), version);
    },

    findPromo: (code: string, today: string) => activePromo(today, code),

    async zipStatus(zip: string): Promise<boolean | null> {
      const { count, error } = await sb.from('service_zips').select('zip', { count: 'exact', head: true });
      if (error) throw error;
      if (!count) return null;
      const hit = must(await sb.from('service_zips').select('zip').eq('zip', zip).maybeSingle());
      return hit != null;
    },

    async countRecentFromIp(ipHash: string, sinceIso: string) {
      const { count, error } = await sb.from('quote_requests').select('id', { count: 'exact', head: true })
        .eq('ip_hash', ipHash).gte('created_at', sinceIso);
      if (error) throw error;
      return count ?? 0;
    },

    async saveQuote({ customer, address, quote }: { customer: unknown; address: unknown; quote: unknown }) {
      const rows = must(await sb.rpc('save_quote', { p_customer: customer, p_address: address, p_quote: quote }));
      return { quoteId: rows[0].quote_id, customerId: rows[0].customer_id };
    },

    logMessage,

    async recordInbound({ from, to, body, sid }: { from: string; to: string; body: string; sid: string }) {
      const customer = must(await sb.from('customers').select('id').eq('phone_e164', from).maybeSingle());
      await logMessage({ customer_id: customer?.id ?? null, channel: 'sms', direction: 'in', from_addr: from, to_addr: to, body, status: 'received', provider_id: sid });
      return customer?.id ?? null;
    },

    async setOptOut(phone: string, optedOut: boolean) {
      const { error } = await sb.from('customers').update({ sms_opted_out_at: optedOut ? new Date().toISOString() : null }).eq('phone_e164', phone);
      if (error) throw error;
    },
  };
}
