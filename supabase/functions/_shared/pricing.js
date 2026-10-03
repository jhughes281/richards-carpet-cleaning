// Single source of pricing for Richard's Carpet Cleaning.
// Imported by the website (js/site.js) and by the edge functions, so the
// package cards, the calculator, the server estimate and the stored quote
// can never disagree. No DOM, no Deno, no Node APIs: runs everywhere.
//
// All money is integer cents.

export const MAX_ROOMS = 8;

// Offline fallback. Must match supabase/migrations/*_price_book_seed.sql
// (tests/pricing.test.mjs checks this).
export const DEFAULT_PRICE_BOOK = {
  version: 'default-2026-10-03',
  rooms: { first_cents: 7900, additional_cents: 2000 },
  addons: [
    { key: 'addon_hall', label: 'Hallway', amount_cents: 2500 },
    { key: 'addon_stairs', label: 'Stairs', amount_cents: 4500 },
    { key: 'addon_pet', label: 'Pet treatment', amount_cents: 4900 },
    { key: 'addon_scotchgard', label: 'Scotchgard', amount_cents: 3900 },
    { key: 'addon_sofa', label: 'Sofa or loveseat', amount_cents: 7900 },
  ],
  per_sqft: [{ key: 'tile_sqft', label: 'Tile & grout, per sq ft', amount_cents: 75 }],
  packages: [
    { key: 'pkg_essential', label: 'Essential', rooms: 3, addons: ['addon_hall'], warranty_days: 14 },
    { key: 'pkg_deep', label: 'Deep Clean', rooms: 5, addons: ['addon_hall', 'addon_stairs', 'addon_scotchgard'], warranty_days: 14 },
    { key: 'pkg_platinum', label: 'Platinum', rooms: 8, addons: ['addon_hall', 'addon_sofa', 'addon_scotchgard'], warranty_days: 30 },
  ],
  promo: { code: 'BLUE15', amount_cents: 1500 },
};

// Services the calculator can price. Tile and commercial are quoted on site.
export const ESTIMABLE_SERVICES = ['carpet', 'upholstery', 'pet'];

/** Build a price book from price_book table rows plus the active online promo row (or null). */
export function bookFromRows(rows, promoRow, version) {
  const by = (kind) => rows.filter((r) => r.kind === kind && r.active !== false)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const room = Object.fromEntries(by('room').map((r) => [r.key, r.amount_cents]));
  if (room.room_first == null || room.room_additional == null) {
    throw new Error('price_book is missing room_first or room_additional');
  }
  return {
    version: version ?? 'db',
    rooms: { first_cents: room.room_first, additional_cents: room.room_additional },
    addons: by('addon').map((r) => ({ key: r.key, label: r.label, amount_cents: r.amount_cents })),
    per_sqft: by('per_sqft').map((r) => ({ key: r.key, label: r.label, amount_cents: r.amount_cents })),
    packages: by('package').map((r) => ({
      key: r.key,
      label: r.label,
      rooms: r.includes?.rooms ?? 0,
      addons: r.includes?.addons ?? [],
      warranty_days: r.includes?.warranty_days ?? 14,
    })),
    promo: promoRow ? { code: promoRow.code, amount_cents: promoRow.amount_cents } : null,
  };
}

/** Rooms price: first room, then a flat amount for each additional room. */
export function roomsCents(book, rooms) {
  if (rooms <= 0) return 0;
  return book.rooms.first_cents + (rooms - 1) * book.rooms.additional_cents;
}

/** The calculator settings that reproduce a package. */
export function packageSelection(book, packageKey) {
  const pkg = book.packages.find((p) => p.key === packageKey);
  if (!pkg) return null;
  return { rooms: pkg.rooms, addons: [...pkg.addons] };
}

/**
 * Price a selection.
 * @param {object} book price book
 * @param {{rooms:number, addons:string[]}} sel
 * @param {{code:string, amount_cents:number}|null} promo validated promo, or null
 */
export function quote(book, sel, promo = null) {
  const lines = [];
  const rooms = Math.max(0, Math.min(MAX_ROOMS, Math.trunc(sel.rooms ?? 0)));
  if (rooms > 0) {
    lines.push({ key: 'rooms', label: `${rooms} ${rooms === 1 ? 'room' : 'rooms'}`, qty: rooms, total_cents: roomsCents(book, rooms) });
  }
  const seen = new Set();
  for (const key of sel.addons ?? []) {
    if (seen.has(key)) continue;
    seen.add(key);
    const a = book.addons.find((x) => x.key === key);
    if (!a) throw new Error(`Unknown add-on: ${key}`);
    lines.push({ key, label: a.label, qty: 1, total_cents: a.amount_cents });
  }
  const subtotal_cents = lines.reduce((s, l) => s + l.total_cents, 0);
  const discount_cents = promo && subtotal_cents > 0 ? Math.min(promo.amount_cents, subtotal_cents) : 0;
  return {
    lines,
    subtotal_cents,
    discount_cents,
    promo_code: discount_cents > 0 ? promo.code : null,
    total_cents: subtotal_cents - discount_cents,
  };
}

/** Short human summary, e.g. "3 rooms + hallway + stairs". */
export function describeSelection(book, sel) {
  const q = quote(book, sel);
  // Brand names (Scotchgard) keep their capital letter.
  const lower = (s) => (/^Scotchgard/.test(s) ? s : s.toLowerCase());
  return q.lines.map((l) => lower(l.label)).join(' + ') || 'nothing selected';
}

export function formatUSD(cents) {
  const dollars = cents / 100;
  return '$' + (Number.isInteger(dollars) ? dollars.toLocaleString('en-US') : dollars.toFixed(2));
}
