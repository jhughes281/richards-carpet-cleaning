# Richard's Carpet Cleaning: backend setup (phase 1)

Phase 1 makes the booking form real. Every request is saved in Postgres,
priced on the server from one price book, and texted and emailed to Richard.
The customer gets an email copy.

The site keeps working before any of this is set up. It shows the built-in
prices, and the form tells people to call instead of pretending to send.

## What's where

| Path | What it is |
|---|---|
| `index.html`, `js/site.js`, `js/config.js` | The website (GitHub Pages) |
| `privacy.html`, `terms.html`, `css/legal.css` | Required for SMS consent; review before launch |
| `supabase/migrations/` | Tables, row-level security, `save_quote()`, starting prices |
| `supabase/functions/_shared/pricing.js` | **The only pricing logic.** The website and the server both import it |
| `supabase/functions/_shared/validate.js` | Form rules, used by the browser and the server |
| `supabase/functions/_shared/quote-handler.js` | submit-quote logic (dependency-injected, tested in Node) |
| `supabase/functions/{price-book,submit-quote,twilio-inbound}/` | Edge function entry points (Deno) |
| `tests/backend.test.mjs` | `node --test tests/backend.test.mjs` (23 tests) |
| `tests/mock-functions.mjs` | Local fake backend for testing the site without Supabase |

## 1. Supabase (free tier)

1. Create a project at supabase.com (pick the region closest to Richard).
2. Install the CLI: `npm i -g supabase` (or `scoop install supabase`).
3. From this folder:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
   No CLI? Paste the two files in `supabase/migrations/` into the SQL editor, in order.
4. Optional: add Richard's ZIP codes to `service_zips`. While it's empty, every
   ZIP is accepted and marked unknown. Once it has rows, other ZIPs are flagged
   "OUTSIDE SERVICE AREA" in Richard's text.

## 2. Secrets

```bash
supabase secrets set \
  ALLOWED_ORIGINS="https://jhughes281.github.io,http://localhost:8762" \
  BUSINESS_TZ="America/Chicago" \
  BUSINESS_NAME="Richard's Carpet Cleaning & Upholstery" \
  BUSINESS_PHONE_DISPLAY="(555) 234-8765" \
  OWNER_PHONE="+1XXXXXXXXXX" \
  OWNER_EMAIL="richard@..." \
  IP_HASH_SALT="<any long random string>" \
  RATE_LIMIT_PER_HOUR="5" \
  TWILIO_ACCOUNT_SID="AC..." TWILIO_AUTH_TOKEN="..." TWILIO_FROM="MG... or +1..." \
  TWILIO_WEBHOOK_URL="https://<ref>.supabase.co/functions/v1/twilio-inbound" \
  RESEND_API_KEY="re_..." RESEND_FROM="Richard's Carpet Cleaning <quotes@yourdomain.com>" \
  TURNSTILE_SECRET="0x..."
```

Every notification channel is optional. If a channel's secrets are missing,
that channel is skipped, the failure is logged in `messages`, and the lead is
still saved.

## 3. Deploy the functions

```bash
supabase functions deploy price-book submit-quote twilio-inbound
```

`supabase/config.toml` turns off JWT checks for these three functions,
because the public site and Twilio don't send one. Each function does its own
checks instead: the CORS allow-list, Turnstile, the honeypot field, the
per-IP rate limit, and the Twilio signature.

## 4. Point the website at it

In `js/config.js`:

```js
functionsUrl: 'https://<ref>.supabase.co/functions/v1',
turnstileSiteKey: '0x...',   // public site key, not the secret
```

## 5. Twilio (texts to Richard)

- Buy a local number. US business texting needs **A2P 10DLC registration**
  (brand + campaign) before carriers will deliver. Expect that to take days.
  Until it's approved, Richard still gets the email.
- Use the Messaging Service SID (`MG...`) as `TWILIO_FROM` once registered.
- Set the number's "A message comes in" webhook to the `twilio-inbound` URL
  (HTTP POST). STOP and START replies are then recorded on the customer.

## 6. Resend (email) and Turnstile (spam)

- Resend: verify a sending domain, then set `RESEND_API_KEY` and `RESEND_FROM`.
- Turnstile: Cloudflare dashboard → Turnstile → add the site's hostname.
  The site key goes in `config.js`, and the secret goes in `TURNSTILE_SECRET`.

## Where Richard sees leads (until phase 2)

Supabase dashboard → Table editor → **`lead_inbox`** view: newest first, with
name, phone, address, selections, estimate and notes on one row. He changes
`status` on `quote_requests` as he works each lead.

## Changing prices

Edit the `price_book` table (amounts are in **cents**). The site and the server
pick up the change within 5 minutes. Old quotes keep the price they were given,
because each quote stores its own `price_lines`.

If you also change the starting prices in the seed migration, update
`DEFAULT_PRICE_BOOK` in `pricing.js` to match. The test suite fails if they
drift apart.

## Local testing without Supabase

```bash
node tests/mock-functions.mjs
```

Then open `http://localhost:8762/?functions=http://localhost:8790`. Form
submissions run the real handler, and the texts and emails print in the
terminal. The `?functions=` override only works on localhost.
