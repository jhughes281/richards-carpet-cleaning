// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';

import { DEFAULT_PRICE_BOOK as BOOK, quote, packageSelection, roomsCents, bookFromRows, formatUSD } from '../supabase/functions/_shared/pricing.js';
import { validateQuoteRequest, normalizePhone, localDate } from '../supabase/functions/_shared/validate.js';
import { handleSubmitQuote } from '../supabase/functions/_shared/quote-handler.js';
import { twilioSignature, isValidTwilioRequest, optKeyword } from '../supabase/functions/_shared/twilio.js';

// ---------- pricing ----------

test('room prices match the original calculator (59 + 20 per room)', () => {
  for (let n = 1; n <= 8; n++) assert.equal(roomsCents(BOOK, n), (59 + 20 * n) * 100, `${n} rooms`);
  assert.equal(roomsCents(BOOK, 0), 0);
});

test('package prices come from the calculator', () => {
  const price = (k) => quote(BOOK, packageSelection(BOOK, k)).total_cents;
  assert.equal(price('pkg_essential'), 14400); // 3 rooms 119 + hall 25
  assert.equal(price('pkg_deep'), 26800);      // 5 rooms 159 + hall 25 + stairs 45 + scotchgard 39
  assert.equal(price('pkg_platinum'), 36200);  // 8 rooms 219 + hall 25 + sofa 79 + scotchgard 39
});

test('promo is capped at the subtotal and only applies to a real job', () => {
  const promo = BOOK.promo;
  assert.equal(quote(BOOK, { rooms: 3, addons: ['addon_hall'] }, promo).total_cents, 12900);
  assert.equal(quote(BOOK, { rooms: 0, addons: [] }, promo).discount_cents, 0);
});

test('duplicate add-ons count once; unknown add-ons throw', () => {
  assert.equal(quote(BOOK, { rooms: 1, addons: ['addon_hall', 'addon_hall'] }).total_cents, 7900 + 2500);
  assert.throws(() => quote(BOOK, { rooms: 1, addons: ['addon_free_money'] }));
});

test('rooms are clamped to 0..8', () => {
  assert.equal(quote(BOOK, { rooms: 50, addons: [] }).subtotal_cents, roomsCents(BOOK, 8));
});

test('formatUSD', () => {
  assert.equal(formatUSD(14400), '$144');
  assert.equal(formatUSD(75), '$0.75');
});

test('SQL seed matches DEFAULT_PRICE_BOOK', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.includes('price_book_seed'));
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const rows = [...sql.matchAll(/\('(\w+)',\s*'(\w+)',\s*'([^']+)',\s*(null|\d+),\s*(null|'[^']*')/g)].map((m) => ({
    key: m[1], kind: m[2], label: m[3], amount_cents: m[4] === 'null' ? null : Number(m[4]),
    includes: m[5] === 'null' ? null : JSON.parse(m[5].slice(1, -1)), active: true,
  }));
  assert.equal(rows.length, 11);
  const promo = sql.match(/promo_codes[^;]*values \('(\w+)', (\d+)/);
  const fromSql = bookFromRows(rows, { code: promo[1], amount_cents: Number(promo[2]) }, BOOK.version);
  assert.deepEqual(fromSql, BOOK);
});

// ---------- validation ----------

const CTX = { today: '2026-10-03', maxRooms: 8, addonKeys: BOOK.addons.map((a) => a.key), packageKeys: BOOK.packages.map((p) => p.key) };
const GOOD = {
  name: 'Jane Doe', phone: '(713) 555-0142', email: 'Jane@Example.com', address: '123 Main St', zip: '77004',
  service: 'carpet', preferredDate: '2026-10-09', rooms: 3, addons: ['addon_hall'], package: 'pkg_essential',
  notes: '2 dogs', promo: 'blue15', consent: true, website: '',
};

test('phone normalization', () => {
  assert.equal(normalizePhone('(713) 555-0142'), '+17135550142');
  assert.equal(normalizePhone('1-713-555-0142'), '+17135550142');
  assert.equal(normalizePhone('555-0142'), null);
  assert.equal(normalizePhone('(013) 555-0142'), null);
});

test('valid request passes and is normalized', () => {
  const { errors, value } = validateQuoteRequest(GOOD, CTX);
  assert.deepEqual(errors, {});
  assert.equal(value.phone, '+17135550142');
  assert.equal(value.email, 'jane@example.com');
  assert.equal(value.promo, 'BLUE15');
});

test('each bad field gets its own message', () => {
  const { errors } = validateQuoteRequest({ ...GOOD, name: '', phone: '123', zip: '7700', preferredDate: '2026-10-02', consent: false, addons: ['x'] }, CTX);
  assert.deepEqual(Object.keys(errors).sort(), ['addons', 'consent', 'name', 'phone', 'preferredDate', 'zip']);
});

test('carpet with nothing selected is rejected; tile is not', () => {
  assert.ok(validateQuoteRequest({ ...GOOD, rooms: 0, addons: [] }, CTX).errors.rooms);
  assert.deepEqual(validateQuoteRequest({ ...GOOD, service: 'tile', rooms: 0, addons: [] }, CTX).errors, {});
});

test('business-local date: 8pm Central on Oct 3 is still Oct 3 (UTC says Oct 4)', () => {
  const evening = new Date('2026-10-04T01:00:00Z');
  assert.equal(localDate(evening, 'America/Chicago'), '2026-10-03');
});

// ---------- submit-quote handler, with a fake database ----------

function fakeDeps(overrides = {}) {
  const saved = [];
  const messages = [];
  const sent = [];
  const deps = {
    db: {
      loadPriceBook: async () => BOOK,
      findPromo: async (code) => (code === 'BLUE15' ? { code: 'BLUE15', amount_cents: 1500 } : null),
      zipStatus: async (zip) => (zip === '77004' ? true : zip === '99999' ? false : null),
      countRecentFromIp: async () => 0,
      saveQuote: async (row) => { saved.push(row); return { quoteId: 'q1', customerId: 'c1' }; },
      logMessage: async (row) => { messages.push(row); },
    },
    notify: {
      sms: async (to, body) => { sent.push({ ch: 'sms', to, body }); return { id: 'SM1' }; },
      email: async (m) => { sent.push({ ch: 'email', ...m }); return { id: 'em1' }; },
    },
    verifyTurnstile: null,
    env: { businessTz: 'America/Chicago', businessName: "Richard's", businessPhoneDisplay: '(555) 234-8765', ownerPhone: '+17135550000', ownerEmail: 'richard@example.com', ipSalt: 's', rateLimitPerHour: 5 },
    now: new Date('2026-10-03T15:00:00Z'),
    ...overrides,
  };
  return { deps, saved, messages, sent };
}

test('happy path: server ignores any client price, saves, notifies three ways', async () => {
  const { deps, saved, messages, sent } = fakeDeps();
  const res = await handleSubmitQuote({ ...GOOD, estimateCents: 1 }, { ip: '1.2.3.4' }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.json.estimateCents, 12900);
  assert.equal(saved[0].quote.est_total_cents, 12900);
  assert.equal(saved[0].quote.promo_code, 'BLUE15');
  assert.equal(saved[0].customer.phone_e164, '+17135550142');
  assert.equal(sent.length, 3);
  assert.match(sent[0].body, /Jane Doe \(713\) 555-0142, 77004\. Carpet cleaning: 3 rooms \+ hallway, est \$129 \(BLUE15\)\. Wants Fri, Oct 9\. Notes: 2 dogs/);
  assert.match(sent[2].text, /Estimate: \$129 before tax/);
  assert.ok(messages.every((m) => m.status === 'sent'));
});

test('unknown promo is ignored, not an error', async () => {
  const { deps } = fakeDeps();
  const res = await handleSubmitQuote({ ...GOOD, promo: 'FAKE' }, { ip: 'x' }, deps);
  assert.equal(res.json.estimateCents, 14400);
});

test('honeypot: pretend success, store nothing', async () => {
  const { deps, saved, sent } = fakeDeps();
  const res = await handleSubmitQuote({ ...GOOD, website: 'http://spam' }, { ip: 'x' }, deps);
  assert.equal(res.status, 200);
  assert.equal(saved.length + sent.length, 0);
});

test('validation errors return 422 and save nothing', async () => {
  const { deps, saved } = fakeDeps();
  const res = await handleSubmitQuote({ ...GOOD, phone: '12' }, { ip: 'x' }, deps);
  assert.equal(res.status, 422);
  assert.ok(res.json.errors.phone);
  assert.equal(saved.length, 0);
});

test('rate limit returns 429', async () => {
  const { deps, saved } = fakeDeps();
  deps.db.countRecentFromIp = async () => 5;
  const res = await handleSubmitQuote(GOOD, { ip: 'x' }, deps);
  assert.equal(res.status, 429);
  assert.equal(saved.length, 0);
});

test('failed Turnstile returns 400', async () => {
  const { deps } = fakeDeps({ verifyTurnstile: async () => false });
  assert.equal((await handleSubmitQuote(GOOD, { ip: 'x' }, deps)).status, 400);
});

test('a failed text still saves the lead and logs the failure', async () => {
  const { deps, saved, messages } = fakeDeps();
  deps.notify.sms = async () => { throw new Error('Twilio 401'); };
  const res = await handleSubmitQuote(GOOD, { ip: 'x' }, deps);
  assert.equal(res.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(messages.find((m) => m.channel === 'sms').status, 'failed');
});

test('outside service area is flagged to Richard and the customer', async () => {
  const { deps, sent } = fakeDeps();
  const res = await handleSubmitQuote({ ...GOOD, zip: '99999' }, { ip: 'x' }, deps);
  assert.equal(res.json.inServiceArea, false);
  assert.match(res.json.message, /outside our usual area/);
  assert.match(sent[0].body, /OUTSIDE SERVICE AREA/);
});

test('tile is saved without an estimate', async () => {
  const { deps, saved } = fakeDeps();
  const res = await handleSubmitQuote({ ...GOOD, service: 'tile', rooms: 0, addons: [] }, { ip: 'x' }, deps);
  assert.equal(res.json.estimateCents, null);
  assert.equal(saved[0].quote.est_total_cents, null);
});

// ---------- Twilio ----------

test('Twilio signature matches a reference HMAC-SHA1', async () => {
  const url = 'https://abc.supabase.co/functions/v1/twilio-inbound';
  const params = { From: '+17135550142', To: '+17135550000', Body: 'STOP', MessageSid: 'SM123' };
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const reference = createHmac('sha1', 'tok').update(data).digest('base64');
  assert.equal(await twilioSignature('tok', url, params), reference);
  assert.equal(await isValidTwilioRequest('tok', url, params, reference), true);
  assert.equal(await isValidTwilioRequest('tok', url, { ...params, Body: 'START' }, reference), false);
  assert.equal(await isValidTwilioRequest('', url, params, reference), false);
});

test('opt keywords', () => {
  assert.equal(optKeyword(' stop '), 'out');
  assert.equal(optKeyword('Start'), 'in');
  assert.equal(optKeyword('stop texting me pls'), null);
});
