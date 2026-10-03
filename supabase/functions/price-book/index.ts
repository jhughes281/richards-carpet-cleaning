// GET /functions/v1/price-book
// Public. Returns the active price book so the website's package cards and
// calculator render the same numbers the server will charge.
import { makeDb } from '../_shared/db.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { localDate } from '../_shared/validate.js';

const db = makeDb();
const tz = Deno.env.get('BUSINESS_TZ') ?? 'America/Chicago';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'GET') return json(req, 405, { error: 'Use GET.' });
  try {
    const book = await db.loadPriceBook(localDate(new Date(), tz));
    return json(req, 200, book, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    console.error('price-book failed', err);
    return json(req, 500, { error: 'Prices are unavailable right now.' });
  }
});
