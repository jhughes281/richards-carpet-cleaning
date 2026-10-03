// Request validation for submit-quote. Pure functions, shared with the Node tests.

export const SERVICES = {
  carpet: 'Carpet cleaning',
  upholstery: 'Upholstery / sofa',
  tile: 'Tile & grout',
  pet: 'Pet treatment + carpet',
  commercial: 'Commercial / rental',
  rug: 'Area rugs',
  mattress: 'Mattresses',
  water: 'Water extraction',
  repair: 'Carpet repair / re-stretching',
  auto: 'Auto, RV & boat interiors',
  leather: 'Leather furniture',
};

// Services Richard should hear about right away.
export const URGENT_SERVICES = ['water'];

// Bump when the consent sentence on the form changes, so every stored
// consent points at the exact wording the customer saw.
export const CONSENT_TEXT_VERSION = '2026-10-a';

const MAX_DAYS_AHEAD = 120;

/** "YYYY-MM-DD" for `date` in the business time zone. */
export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** US numbers only. Returns +1XXXXXXXXXX or null. */
export function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10 || /^[01]/.test(digits)) return null;
  return '+1' + digits;
}

export function formatPhone(e164) {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * @param {object} body raw JSON from the browser
 * @param {{today:string, addonKeys:string[], packageKeys:string[], maxRooms:number}} ctx
 * @returns {{errors: Record<string,string>, value: object|null}}
 */
export function validateQuoteRequest(body, ctx) {
  const errors = {};
  const b = body && typeof body === 'object' ? body : {};

  const name = str(b.name, 120);
  if (name.length < 2) errors.name = 'Enter your name.';

  const phone = normalizePhone(b.phone);
  if (!phone) errors.phone = 'Enter a 10-digit US phone number.';

  const email = str(b.email, 200).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Check the email address, or leave it blank.';

  const address = str(b.address, 200);
  if (address.length < 4) errors.address = 'Enter the street address for the job.';

  const zip = str(b.zip, 10);
  if (!/^\d{5}$/.test(zip)) errors.zip = 'Enter a 5-digit ZIP code.';

  const service = str(b.service, 20);
  if (!(service in SERVICES)) errors.service = 'Pick a service.';

  const preferredDate = str(b.preferredDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
    errors.preferredDate = 'Pick a date.';
  } else if (preferredDate < ctx.today) {
    errors.preferredDate = 'Pick today or a later date.';
  } else if (preferredDate > addDays(ctx.today, MAX_DAYS_AHEAD)) {
    errors.preferredDate = `We book up to ${MAX_DAYS_AHEAD} days out. Pick an earlier date or call.`;
  }

  const rooms = Number(b.rooms ?? 0);
  if (!Number.isInteger(rooms) || rooms < 0 || rooms > ctx.maxRooms) {
    errors.rooms = `Rooms must be 0 to ${ctx.maxRooms}. Call for larger homes.`;
  }

  const addons = Array.isArray(b.addons) ? [...new Set(b.addons.map(String))] : [];
  if (addons.some((a) => !ctx.addonKeys.includes(a))) errors.addons = 'Unknown add-on selected. Reload the page and try again.';

  const packageKey = b.package ? str(b.package, 40) : null;
  if (packageKey && !ctx.packageKeys.includes(packageKey)) errors.package = 'Unknown package. Reload the page and try again.';

  if (['carpet', 'upholstery', 'pet'].includes(service) && !errors.rooms && rooms === 0 && addons.length === 0) {
    errors.rooms = 'Choose at least one room or add-on in the estimate.';
  }

  if (b.consent !== true) errors.consent = 'Tick the box so Richard can contact you about this quote.';

  const notes = str(b.notes, 1000);
  const promo = b.promo ? str(b.promo, 30).toUpperCase() : null;

  if (Object.keys(errors).length) return { errors, value: null };
  return {
    errors,
    value: { name, phone, email: email || null, address, zip, service, preferredDate, rooms, addons, packageKey, notes, promo, consentTextVersion: CONSENT_TEXT_VERSION },
  };
}
