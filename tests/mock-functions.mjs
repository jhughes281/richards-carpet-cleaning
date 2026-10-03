// Local stand-in for the Supabase edge functions, for testing the website
// before (or without) a Supabase project. Runs the real submit-quote handler
// against an in-memory database and prints texts/emails instead of sending.
//
//   node tests/mock-functions.mjs
//   then open http://localhost:8762/?functions=http://localhost:8790
import { createServer } from 'node:http';
import { DEFAULT_PRICE_BOOK } from '../supabase/functions/_shared/pricing.js';
import { handleSubmitQuote } from '../supabase/functions/_shared/quote-handler.js';

const PORT = 8790;
const quotes = [];

const deps = {
  db: {
    loadPriceBook: async () => ({ ...DEFAULT_PRICE_BOOK, version: 'mock' }),
    findPromo: async (code) => (code === DEFAULT_PRICE_BOOK.promo.code ? DEFAULT_PRICE_BOOK.promo : null),
    zipStatus: async () => null,
    countRecentFromIp: async (hash, since) => quotes.filter((q) => q.quote.ip_hash === hash && q.at >= since).length,
    saveQuote: async (row) => {
      quotes.push({ ...row, at: new Date().toISOString() });
      console.log('\nSAVED quote', quotes.length, JSON.stringify(row.quote, null, 2));
      return { quoteId: `mock-${quotes.length}`, customerId: 'mock-customer' };
    },
    logMessage: async (m) => console.log('message log:', m.channel, m.to_addr, m.status),
  },
  notify: {
    sms: async (to, body) => { console.log(`\nSMS to ${to}:\n${body}`); return { id: 'SMmock' }; },
    email: async ({ to, subject, text }) => { console.log(`\nEMAIL to ${to}: ${subject}\n${text}`); return { id: 'mock' }; },
  },
  verifyTurnstile: null,
  env: {
    businessTz: 'America/Chicago', businessName: "Richard's Carpet Cleaning & Upholstery", businessPhoneDisplay: '(555) 234-8765',
    ownerPhone: '+15550000000', ownerEmail: 'richard@example.com', ipSalt: 'mock', rateLimitPerHour: 5,
  },
};

createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/price-book' && req.method === 'GET') return send(200, await deps.db.loadPriceBook());
  if (req.url === '/submit-quote' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const { status, json } = await handleSubmitQuote(JSON.parse(raw), { ip: req.socket.remoteAddress }, { ...deps, now: new Date() });
      return send(status, json);
    } catch (err) {
      console.error(err);
      return send(500, { errors: { form: 'Mock server error.' } });
    }
  }
  send(404, { error: 'not found' });
}).listen(PORT, () => console.log(`Mock functions on http://localhost:${PORT}`));
