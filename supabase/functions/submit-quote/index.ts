// POST /functions/v1/submit-quote
// Public. Validates the booking form, recomputes the price on the server,
// saves the lead, then texts and emails Richard and emails the customer.
import { makeDb } from '../_shared/db.ts';
import { makeNotify, makeTurnstile } from '../_shared/notify.ts';
import { clientIp, corsHeaders, json } from '../_shared/http.ts';
import { handleSubmitQuote } from '../_shared/quote-handler.js';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;

const deps = {
  db: makeDb(),
  notify: makeNotify(),
  verifyTurnstile: makeTurnstile(),
  env: {
    businessTz: env('BUSINESS_TZ', 'America/Chicago'),
    businessName: env('BUSINESS_NAME', "Richard's Carpet Cleaning & Upholstery"),
    businessPhoneDisplay: env('BUSINESS_PHONE_DISPLAY', '(555) 234-8765'),
    ownerPhone: env('OWNER_PHONE'),
    ownerEmail: env('OWNER_EMAIL'),
    ipSalt: env('IP_HASH_SALT', 'change-me'),
    rateLimitPerHour: Number(env('RATE_LIMIT_PER_HOUR', '5')),
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'Use POST.' });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { errors: { form: 'The request was not valid JSON.' } });
  }

  try {
    const { status, json: out } = await handleSubmitQuote(body, { ip: clientIp(req) }, { ...deps, now: new Date() });
    return json(req, status, out);
  } catch (err) {
    console.error('submit-quote failed', err);
    return json(req, 500, { errors: { form: `Something went wrong saving your request. Please call ${deps.env.businessPhoneDisplay}.` } });
  }
});
