// Runs every migration against PGlite (real Postgres in WASM) and exercises
// the functions and row level security the way Supabase would.
// Run: npm test   (needs `npm install` once for @electric-sql/pglite)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const STRANGER = '00000000-0000-0000-0000-00000000000b';
let db;

// Minimal stand-ins for what Supabase provides: roles, auth.users, auth.uid(),
// and the default table grants Supabase gives anon/authenticated.
const SUPABASE_STUB = `
  create role anon; create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

async function as(role, uid, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

async function newQuote(overrides = {}) {
  const c = { name: 'Jane Doe', phone_e164: '+17135550142', email: 'jane@example.com', consented_at: new Date().toISOString(), consent_text_ver: 'x' };
  const q = {
    service: 'carpet', package_key: 'pkg_essential', rooms: 3, addons: ['addon_hall'], preferred_date: '2026-10-09',
    promo_code: 'BLUE15', est_subtotal_cents: 14400, est_discount_cents: 1500, est_total_cents: 12900,
    price_lines: [{ key: 'rooms', label: '3 rooms', qty: 3, total_cents: 11900 }, { key: 'addon_hall', label: 'Hallway', qty: 1, total_cents: 2500 }],
    price_book_version: 't', ip_hash: 'h', ...overrides,
  };
  const r = await db.query('select * from public.save_quote($1, $2, $3)', [c, { line1: '123 Main St', zip: '77004' }, q]);
  return r.rows[0].quote_id;
}

before(async () => {
  db = new PGlite({ extensions: { citext } });
  await db.exec(SUPABASE_STUB);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  await db.exec(`
    insert into auth.users values ('${ADMIN}', 'richard@example.com'), ('${STRANGER}', 'someone@example.com');
    insert into public.admins (user_id, email) values ('${ADMIN}', 'richard@example.com');
    insert into public.crews (name) values ('Richard');
    insert into public.units (unit_no, description) values ('1', 'Blue Kohler truck-mount');
  `);
});

test('save_quote: repeat customer keeps one row and keeps their email', async () => {
  await newQuote();
  const c = { name: 'Jane D.', phone_e164: '+17135550142', email: null, consented_at: new Date().toISOString(), consent_text_ver: 'x' };
  await db.query('select * from public.save_quote($1,$2,$3)', [c, { line1: '9 Oak', zip: '77005' }, { service: 'tile', rooms: 0, addons: [], preferred_date: '2026-10-10' }]);
  const r = await db.query(`select name, email from public.customers where phone_e164 = '+17135550142'`);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].email, 'jane@example.com');
});

test('constraints reject bad data', async () => {
  await assert.rejects(db.query(`insert into public.price_book (key, kind, label) values ('bad', 'addon', 'no price')`));
  await assert.rejects(db.query(`insert into public.quote_requests (customer_id, service, preferred_date) select id, 'carwash', '2026-10-10' from public.customers limit 1`));
});

test('anon can see nothing and cannot call any function', async () => {
  await as('anon', null, async () => {
    assert.equal((await db.query('select count(*)::int n from public.quote_requests')).rows[0].n, 0);
    await assert.rejects(db.query(`select public.book_quote(gen_random_uuid(), current_date, 'morning')`), /permission denied/);
    await assert.rejects(db.query(`select * from public.save_quote('{}', '{}', '{}')`), /permission denied/);
  });
});

test('a signed-in non-admin sees no rows and cannot book', async () => {
  const qid = await newQuote();
  await as('authenticated', STRANGER, async () => {
    assert.equal((await db.query('select count(*)::int n from public.customers')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int n from public.lead_inbox')).rows[0].n, 0);
    assert.equal((await db.query('select public.is_admin() a')).rows[0].a, false);
    await assert.rejects(db.query(`select public.book_quote($1, '2026-10-09', 'morning')`, [qid]), /not authorized/);
  });
});

test('admin sees leads, books a quote, and the estimate becomes job items', async () => {
  const qid = await newQuote();
  await as('authenticated', ADMIN, async () => {
    assert.ok((await db.query('select count(*)::int n from public.lead_inbox')).rows[0].n >= 1);
    const crew = (await db.query('select id from public.crews limit 1')).rows[0].id;
    const unit = (await db.query('select id from public.units limit 1')).rows[0].id;
    const job = (await db.query(`select public.book_quote($1, '2026-10-09', 'morning', $2, $3) id`, [qid, crew, unit])).rows[0].id;

    const items = (await db.query('select label, qty, unit_cents, from_estimate from public.job_items where job_id = $1 order by sort', [job])).rows;
    assert.deepEqual(items.map((i) => [i.label, i.unit_cents]), [['3 rooms', 11900], ['Hallway', 2500], ['Online discount (BLUE15)', -1500]]);
    assert.ok(items.every((i) => i.from_estimate));

    const board = (await db.query('select firm_total_cents, crew_name, unit_no, customer_name, warranty_until from public.job_board where id = $1', [job])).rows[0];
    assert.equal(board.firm_total_cents, 12900);
    assert.equal(board.crew_name, 'Richard');
    assert.equal(board.unit_no, '1');

    assert.equal((await db.query('select status from public.quote_requests where id = $1', [qid])).rows[0].status, 'booked');
    await assert.rejects(db.query(`select public.book_quote($1, '2026-10-10', 'morning')`, [qid]), /already booked/);
  });
});

test('warranty days come from the package: Platinum gets 30', async () => {
  const qid = await newQuote({ package_key: 'pkg_platinum', price_lines: [], est_discount_cents: 0 });
  await as('authenticated', ADMIN, async () => {
    const job = (await db.query(`select public.book_quote($1, '2026-10-12', 'afternoon') id`, [qid])).rows[0].id;
    assert.equal((await db.query('select warranty_days from public.jobs where id = $1', [job])).rows[0].warranty_days, 30);
  });
});

test('complete_job stamps completion, starts the warranty clock, closes the lead', async () => {
  const qid = await newQuote({ package_key: null });
  await as('authenticated', ADMIN, async () => {
    const job = (await db.query(`select public.book_quote($1, '2026-10-09', 'midday') id`, [qid])).rows[0].id;
    const until = (await db.query(`select public.complete_job($1, 'America/Chicago') d`, [job])).rows[0].d;
    const today = (await db.query(`select (now() at time zone 'America/Chicago')::date d`)).rows[0].d;
    assert.equal((until - today) / 86400000, 14);
    const j = (await db.query('select status, completed_at from public.jobs where id = $1', [job])).rows[0];
    assert.equal(j.status, 'completed');
    assert.ok(j.completed_at);
    assert.equal((await db.query('select status from public.quote_requests where id = $1', [qid])).rows[0].status, 'completed');
  });
});

test('only promo lines may be negative', async () => {
  await as('authenticated', ADMIN, async () => {
    const job = (await db.query('select id from public.jobs limit 1')).rows[0].id;
    await assert.rejects(db.query(`insert into public.job_items (job_id, label, unit_cents) values ($1, 'Freebie', -500)`, [job]), /only_promo_negative/);
    await db.query(`insert into public.job_items (job_id, label, unit_cents, adjust_reason) values ($1, 'Extra closet', 2000, 'Customer added on site')`, [job]);
  });
});
