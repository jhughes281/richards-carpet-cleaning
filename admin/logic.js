// Pure helpers for the admin app. No DOM, no network: tested in Node.
import { formatUSD } from '../supabase/functions/_shared/pricing.js';
import { localDate, formatPhone, SERVICES } from '../supabase/functions/_shared/validate.js';

export { formatUSD, localDate, formatPhone, SERVICES };

export const WINDOWS = [
  { key: 'morning', label: 'Morning', hours: '8–10 am' },
  { key: 'midday', label: 'Midday', hours: '11 am–1 pm' },
  { key: 'afternoon', label: 'Afternoon', hours: '2–4 pm' },
  { key: 'evening', label: 'Evening', hours: '5–7 pm' },
];
export const windowLabel = (key) => WINDOWS.find((w) => w.key === key)?.label ?? key;
export const windowOrder = (key) => WINDOWS.findIndex((w) => w.key === key);

// Inbox tabs. Every lead status lands in exactly one.
export const LEAD_TABS = [
  { key: 'new', label: 'New', statuses: ['new'] },
  { key: 'working', label: 'Working', statuses: ['contacted', 'quoted'] },
  { key: 'booked', label: 'Booked', statuses: ['booked'] },
  { key: 'closed', label: 'Closed', statuses: ['completed', 'lost', 'cancelled'] },
];
export const tabForStatus = (status) => LEAD_TABS.find((t) => t.statuses.includes(status))?.key ?? 'closed';

// A new lead nobody has touched for this long gets flagged.
export const WAITING_FLAG_MINUTES = 30;

export function minutesSince(iso, now) {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
}

export function timeAgo(iso, now) {
  const m = minutesSince(iso, now);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function isWaiting(lead, now) {
  return lead.status === 'new' && minutesSince(lead.created_at, now) >= WAITING_FLAG_MINUTES;
}

/** Newest first, but waiting leads float to the top so nothing goes cold. */
export function sortLeads(leads, now) {
  return [...leads].sort((a, b) => {
    const wa = isWaiting(a, now), wb = isWaiting(b, now);
    if (wa !== wb) return wa ? -1 : 1;
    if (wa && wb) return new Date(a.created_at) - new Date(b.created_at); // oldest waiting first
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

export const lineTotal = (item) => item.qty * item.unit_cents;
/** $25, or −$15 for the discount line (formatUSD alone would print $-15). */
export const formatSigned = (cents) => (cents < 0 ? '−' + formatUSD(-cents) : formatUSD(cents));
export const itemsTotal = (items) => items.reduce((s, i) => s + lineTotal(i), 0);

/**
 * An item needs a reason if it was added after booking, or if its qty or
 * price no longer match what the customer was quoted online.
 */
export function needsReason(item, original) {
  if (!item.from_estimate) return true;
  if (!original) return false;
  return item.qty !== original.qty || item.unit_cents !== original.unit_cents;
}

/** Job items built from a quote's frozen estimate (mirrors SQL book_quote). */
export function itemsFromQuote(quote) {
  const items = (quote.price_lines ?? []).map((l, i) => ({
    price_key: l.key, label: l.label, qty: 1, unit_cents: l.total_cents, from_estimate: true, sort: i + 1, adjust_reason: null,
  }));
  if ((quote.est_discount_cents ?? 0) > 0) {
    items.push({ price_key: 'promo', label: `Online discount (${quote.promo_code})`, qty: 1, unit_cents: -quote.est_discount_cents, from_estimate: true, sort: 999, adjust_reason: null });
  }
  return items;
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function prettyDate(isoDate, { weekday = 'short' } = {}) {
  return new Date(isoDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday, month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Jobs that share a truck or a crew in the same date + time window.
 * Returns Map<jobId, string[]> of human-readable clashes.
 */
export function findConflicts(jobs) {
  const out = new Map();
  const live = jobs.filter((j) => j.status !== 'cancelled' && j.status !== 'completed');
  const flag = (field, name) => {
    const groups = new Map();
    for (const j of live) {
      if (!j[field]) continue;
      const k = `${j.scheduled_date}|${j.time_window}|${j[field]}`;
      groups.set(k, [...(groups.get(k) ?? []), j]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const j of group) out.set(j.id, [...(out.get(j.id) ?? []), name(j)]);
    }
  };
  flag('unit_id', (j) => `Truck ${j.unit_no ?? ''} double-booked`.replace('  ', ' '));
  flag('crew_id', (j) => `${j.crew_name ?? 'Crew'} double-booked`);
  return out;
}

/** Would booking this slot clash with an existing job? */
export function slotClashes(jobs, { date, window, crewId, unitId }, ignoreJobId = null) {
  return jobs.filter((j) => j.id !== ignoreJobId && j.status !== 'cancelled' && j.status !== 'completed'
    && j.scheduled_date === date && j.time_window === window
    && ((unitId && j.unit_id === unitId) || (crewId && j.crew_id === crewId)));
}

/** Jobs grouped by date for the Week view, each day sorted by window. */
export function groupByDay(jobs, fromDate, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    out.push({ date, jobs: jobs.filter((j) => j.scheduled_date === date).sort((a, b) => windowOrder(a.time_window) - windowOrder(b.time_window)) });
  }
  return out;
}

export const mapUrl = (line1, zip) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${line1}, ${zip}`)}`;
export const telHref = (e164) => `tel:${e164}`;
export const smsHref = (e164) => `sms:${e164}`;

/** What the lead asked for, in one line. */
export function leadSummary(lead) {
  const svc = SERVICES[lead.service] ?? lead.service;
  if (!lead.est_total_cents && lead.est_total_cents !== 0) return `${svc} · priced on site`;
  return `${svc} · ${formatUSD(lead.est_total_cents)}`;
}
