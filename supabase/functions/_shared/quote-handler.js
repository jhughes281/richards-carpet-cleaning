// submit-quote logic with every outside dependency passed in, so the same
// code runs in the Deno edge function and in the Node tests.

import { quote, describeSelection, formatUSD, MAX_ROOMS, ESTIMABLE_SERVICES } from './pricing.js';
import { validateQuoteRequest, localDate, formatPhone, SERVICES } from './validate.js';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function prettyDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function ownerSms(v, est, book, inArea) {
  const sel = ESTIMABLE_SERVICES.includes(v.service) ? describeSelection(book, v) : 'price on site';
  const price = est ? `est ${formatUSD(est.total_cents)}${est.promo_code ? ` (${est.promo_code})` : ''}` : 'no estimate';
  const area = inArea === false ? ' OUTSIDE SERVICE AREA.' : '';
  const notes = v.notes ? ` Notes: ${v.notes.slice(0, 160)}` : '';
  return `New quote: ${v.name} ${formatPhone(v.phone)}, ${v.zip}.${area} ${SERVICES[v.service]}: ${sel}, ${price}. Wants ${prettyDate(v.preferredDate)}.${notes}`;
}

export function customerEmail(v, est, env) {
  const first = v.name.split(/\s+/)[0];
  const lines = [
    `Hi ${first},`,
    '',
    `Thanks for asking ${env.businessName} for a quote. Richard has your request and will call or text ${formatPhone(v.phone)} to confirm a time.`,
    '',
    `Service: ${SERVICES[v.service]}`,
    `Preferred date: ${prettyDate(v.preferredDate)}`,
    `Address: ${v.address}, ${v.zip}`,
  ];
  if (est) {
    for (const l of est.lines) lines.push(`  ${l.label}: ${formatUSD(l.total_cents)}`);
    if (est.discount_cents) lines.push(`  Online discount (${est.promo_code}): -${formatUSD(est.discount_cents)}`);
    lines.push(`Estimate: ${formatUSD(est.total_cents)} before tax. Richard confirms the final price on site before any work starts.`);
  } else {
    lines.push('Richard prices this service on site and confirms it before any work starts.');
  }
  lines.push('', `Questions? Call or text ${env.businessPhoneDisplay}.`);
  return { subject: `Your quote request – ${env.businessName}`, text: lines.join('\n') };
}

/**
 * @returns {Promise<{status:number, json:object}>}
 */
export async function handleSubmitQuote(body, meta, deps) {
  const { db, notify, verifyTurnstile, env, now = new Date() } = deps;

  // Honeypot: bots fill every field. Pretend success, store nothing.
  if (body && typeof body === 'object' && String(body.website ?? '').trim() !== '') {
    return { status: 200, json: { quoteId: null, message: 'Thanks. Richard has your request.' } };
  }

  if (verifyTurnstile && !(await verifyTurnstile(body?.turnstileToken, meta.ip))) {
    return { status: 400, json: { errors: { form: 'The spam check didn\'t pass. Reload the page and try again, or call us.' } } };
  }

  const today = localDate(now, env.businessTz);
  const book = await db.loadPriceBook(today);
  const { errors, value: v } = validateQuoteRequest(body, {
    today,
    maxRooms: MAX_ROOMS,
    addonKeys: book.addons.map((a) => a.key),
    packageKeys: book.packages.map((p) => p.key),
  });
  if (!v) return { status: 422, json: { errors } };

  const ipHash = await sha256Hex(`${env.ipSalt}:${meta.ip ?? 'unknown'}`);
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if ((await db.countRecentFromIp(ipHash, since)) >= env.rateLimitPerHour) {
    return { status: 429, json: { errors: { form: `Too many requests from this connection. Please call ${env.businessPhoneDisplay}.` } } };
  }

  const promo = v.promo ? await db.findPromo(v.promo, today) : null;
  const est = ESTIMABLE_SERVICES.includes(v.service) ? quote(book, v, promo) : null;
  const inArea = await db.zipStatus(v.zip);

  const { quoteId, customerId } = await db.saveQuote({
    customer: { name: v.name, phone_e164: v.phone, email: v.email, consent_text_ver: v.consentTextVersion, consented_at: now.toISOString() },
    address: { line1: v.address, zip: v.zip, in_service_area: inArea },
    quote: {
      service: v.service,
      package_key: v.packageKey,
      rooms: v.rooms,
      addons: v.addons,
      preferred_date: v.preferredDate,
      notes: v.notes || null,
      promo_code: est?.promo_code ?? null,
      est_subtotal_cents: est?.subtotal_cents ?? null,
      est_discount_cents: est?.discount_cents ?? null,
      est_total_cents: est?.total_cents ?? null,
      price_lines: est?.lines ?? null,
      price_book_version: book.version,
      ip_hash: ipHash,
      utm: body.utm && typeof body.utm === 'object' ? body.utm : null,
    },
  });

  // The lead is saved. Notifications are best effort: a failed text or email
  // is logged, never turned into an error for the customer.
  const sends = [];
  if (env.ownerPhone) {
    sends.push(['sms', env.ownerPhone, () => notify.sms(env.ownerPhone, ownerSms(v, est, book, inArea))]);
  }
  if (env.ownerEmail) {
    const text = ownerSms(v, est, book, inArea);
    sends.push(['email', env.ownerEmail, () => notify.email({ to: env.ownerEmail, subject: `New quote: ${v.name}, ${v.zip}`, text, replyTo: v.email })]);
  }
  if (v.email) {
    const mail = customerEmail(v, est, env);
    sends.push(['email', v.email, () => notify.email({ to: v.email, ...mail })]);
  }
  for (const [channel, to, send] of sends) {
    try {
      const res = await send();
      await db.logMessage({ customer_id: customerId, quote_id: quoteId, channel, direction: 'out', to_addr: to, status: 'sent', provider_id: res?.id ?? null });
    } catch (err) {
      await db.logMessage({ customer_id: customerId, quote_id: quoteId, channel, direction: 'out', to_addr: to, status: 'failed', error: String(err?.message ?? err).slice(0, 500) });
    }
  }

  const first = v.name.split(/\s+/)[0];
  return {
    status: 200,
    json: {
      quoteId,
      estimateCents: est?.total_cents ?? null,
      discountCents: est?.discount_cents ?? 0,
      inServiceArea: inArea,
      message: inArea === false
        ? `Thanks, ${first}. ${v.zip} is outside our usual area, so Richard will call to talk about travel.`
        : `Thanks, ${first}. Richard has your request and will call or text to confirm a time.`,
    },
  };
}
