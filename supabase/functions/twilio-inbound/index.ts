// POST /functions/v1/twilio-inbound
// Twilio calls this when someone texts Richard's business number. Logs the
// message and records STOP / START so the database matches Twilio's opt-outs.
// Set the number's "A message comes in" webhook to this function's URL.
import { makeDb } from '../_shared/db.ts';
import { isValidTwilioRequest, optKeyword } from '../_shared/twilio.js';

const db = makeDb();
const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
// The exact public URL Twilio posts to. The signature is computed over it,
// and req.url inside the edge runtime is not the public URL.
const webhookUrl = Deno.env.get('TWILIO_WEBHOOK_URL') ?? '';

const twiml = (status = 200) =>
  new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status, headers: { 'Content-Type': 'text/xml' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Use POST.', { status: 405 });

  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  if (!(await isValidTwilioRequest(authToken, webhookUrl, params, req.headers.get('X-Twilio-Signature')))) {
    return new Response('Invalid signature.', { status: 403 });
  }

  try {
    await db.recordInbound({ from: params.From, to: params.To, body: params.Body ?? '', sid: params.MessageSid });
    const kw = optKeyword(params.Body);
    if (kw) await db.setOptOut(params.From, kw === 'out');
  } catch (err) {
    console.error('twilio-inbound failed', err);
  }
  // Empty reply: Twilio sends its own STOP/START confirmations.
  return twiml();
});
