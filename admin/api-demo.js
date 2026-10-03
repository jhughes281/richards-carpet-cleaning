// Demo data layer: same interface as api-supabase.js, backed by memory.
// Only reachable on localhost with ?demo. Every record is sample data.
import { DEFAULT_PRICE_BOOK, quote as priceQuote } from '../supabase/functions/_shared/pricing.js';
import { itemsFromQuote, addDays, localDate } from './logic.js';

const uid = () => crypto.randomUUID();
const clone = (x) => structuredClone(x);

export function makeDemoApi({ businessTz }) {
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const today = localDate(new Date(), businessTz);

  const crews = [{ id: uid(), name: 'Richard', phone_e164: null, active: true }, { id: uid(), name: 'Marcus (helper)', phone_e164: null, active: true }];
  const units = [{ id: uid(), unit_no: '1', description: 'Blue Kohler truck-mount', last_service_on: null, active: true }];

  const customers = [];
  const addresses = [];
  const leads = [];
  const jobs = [];
  const items = [];

  function addLead({ name, phone, email, line1, zip, inArea = true, service, rooms = 0, addons = [], pkg = null, date, notes = null, minutesAgo, status = 'new' }) {
    const c = { id: uid(), name, phone_e164: phone, email };
    const a = { id: uid(), customer_id: c.id, line1, zip, in_service_area: inArea, access_notes: null };
    const estimable = ['carpet', 'upholstery', 'pet'].includes(service);
    const q = estimable ? priceQuote(DEFAULT_PRICE_BOOK, { rooms, addons }, DEFAULT_PRICE_BOOK.promo) : null;
    const lead = {
      id: uid(), customer_id: c.id, address_id: a.id, status, service, package_key: pkg, rooms, addons, preferred_date: date, notes,
      promo_code: q?.promo_code ?? null, est_subtotal_cents: q?.subtotal_cents ?? null, est_discount_cents: q?.discount_cents ?? null,
      est_total_cents: q?.total_cents ?? null, price_lines: q?.lines ?? null, created_at: ago(minutesAgo),
    };
    customers.push(c); addresses.push(a); leads.push(lead);
    return lead;
  }

  function bookSync(quoteId, date, window, crewId, unitId) {
    const q = leads.find((l) => l.id === quoteId);
    const pkg = DEFAULT_PRICE_BOOK.packages.find((p) => p.key === q.package_key);
    const job = {
      id: uid(), quote_id: q.id, customer_id: q.customer_id, address_id: q.address_id, crew_id: crewId || null, unit_id: unitId || null,
      scheduled_date: date, time_window: window, status: 'scheduled', warranty_days: pkg?.warranty_days ?? 14,
      completed_at: null, warranty_until: null, notes: null, created_at: new Date().toISOString(),
    };
    jobs.push(job);
    for (const it of itemsFromQuote(q)) items.push({ id: uid(), job_id: job.id, created_at: new Date().toISOString(), ...it });
    q.status = 'booked';
    return job.id;
  }

  // ---- sample data (clearly fake names, 555 numbers) ----
  addLead({ name: 'Sample: Dana Whitfield', phone: '+17135550101', email: 'dana@example.com', line1: '4410 Bayou Bend Ln', zip: '77004', service: 'carpet', rooms: 3, addons: ['addon_hall'], pkg: 'pkg_essential', date: addDays(today, 3), notes: 'Two cats. Gate code 1942.', minutesAgo: 95 });
  addLead({ name: 'Sample: Luis Romero', phone: '+17135550102', email: null, line1: '901 W Alabama St', zip: '77006', service: 'water', date: today, notes: 'Water heater leaked into the hallway carpet.', minutesAgo: 12 });
  addLead({ name: 'Sample: Priya Natarajan', phone: '+17135550103', email: 'priya@example.com', line1: '2215 Rice Blvd', zip: '77005', service: 'upholstery', rooms: 0, addons: ['addon_sofa', 'addon_scotchgard'], date: addDays(today, 5), minutesAgo: 60 * 26, status: 'contacted' });
  addLead({ name: 'Sample: Greg Holloway', phone: '+17135550104', email: 'greg@example.com', line1: '77 Lakeview Dr', zip: '77581', inArea: false, service: 'carpet', rooms: 5, addons: ['addon_hall', 'addon_stairs', 'addon_scotchgard'], pkg: 'pkg_deep', date: addDays(today, 6), minutesAgo: 60 * 50, status: 'quoted' });
  const b1 = addLead({ name: 'Sample: Tasha Greene', phone: '+17135550105', email: 'tasha@example.com', line1: '3302 Montrose Blvd', zip: '77006', service: 'carpet', rooms: 8, addons: ['addon_hall', 'addon_sofa', 'addon_scotchgard'], pkg: 'pkg_platinum', date: today, minutesAgo: 60 * 72 });
  const b2 = addLead({ name: 'Sample: Ben Ortiz', phone: '+17135550106', email: null, line1: '615 Heights Blvd', zip: '77007', service: 'pet', rooms: 2, addons: ['addon_pet'], date: today, notes: 'Large dog, will be crated.', minutesAgo: 60 * 70 });
  const b3 = addLead({ name: 'Sample: Ana Silva', phone: '+17135550107', email: 'ana@example.com', line1: '1200 Studewood St', zip: '77008', service: 'rug', date: addDays(today, 1), minutesAgo: 60 * 30 });
  const b4 = addLead({ name: 'Sample: Will Carter', phone: '+17135550108', email: null, line1: '4900 Fannin St', zip: '77004', service: 'carpet', rooms: 4, addons: ['addon_stairs'], date: addDays(today, 1), minutesAgo: 60 * 28 });
  addLead({ name: 'Sample: Joy Park', phone: '+17135550109', email: null, line1: '18 Sunset Blvd', zip: '77005', service: 'tile', date: addDays(today, -4), minutesAgo: 60 * 24 * 6, status: 'lost' });

  bookSync(b1.id, today, 'morning', crews[0].id, units[0].id);
  addresses.find((a) => a.id === b1.address_id).access_notes = 'Park in the driveway, side gate is unlocked.';
  bookSync(b2.id, today, 'afternoon', crews[0].id, units[0].id);
  bookSync(b3.id, addDays(today, 1), 'midday', crews[0].id, units[0].id);
  bookSync(b4.id, addDays(today, 1), 'midday', crews[1].id, units[0].id); // same truck, same slot: shows the clash flag

  const leadView = (l) => ({ ...clone(l), customer: clone(customers.find((c) => c.id === l.customer_id)), address: clone(addresses.find((a) => a.id === l.address_id)) });
  const boardRow = (j) => {
    const c = customers.find((x) => x.id === j.customer_id);
    const a = addresses.find((x) => x.id === j.address_id);
    const q = leads.find((x) => x.id === j.quote_id);
    return {
      id: j.id, status: j.status, scheduled_date: j.scheduled_date, time_window: j.time_window, warranty_until: j.warranty_until, notes: j.notes,
      crew_id: j.crew_id, crew_name: crews.find((x) => x.id === j.crew_id)?.name ?? null,
      unit_id: j.unit_id, unit_no: units.find((x) => x.id === j.unit_id)?.unit_no ?? null,
      customer_name: c.name, phone_e164: c.phone_e164, line1: a?.line1, zip: a?.zip, access_notes: a?.access_notes,
      service: q?.service, quote_id: q?.id,
      firm_total_cents: items.filter((i) => i.job_id === j.id).reduce((s, i) => s + i.qty * i.unit_cents, 0),
    };
  };
  const tick = () => new Promise((r) => setTimeout(r, 60));
  let signedIn = true;
  let listener = () => {};

  return {
    demo: true,
    auth: {
      async session() { return signedIn ? { email: 'demo@localhost' } : null; },
      onChange(cb) { listener = cb; },
      async sendLink() { signedIn = true; listener({ email: 'demo@localhost' }); },
      async signOut() { signedIn = false; listener(null); },
      async isAdmin() { return true; },
    },
    leads: {
      async list() { await tick(); return leads.map(leadView).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
      async get(id) {
        await tick();
        const l = leads.find((x) => x.id === id);
        if (!l) throw new Error('Lead not found');
        return { ...leadView(l), messages: [], job_id: jobs.find((j) => j.quote_id === id)?.id ?? null };
      },
      async setStatus(id, status) { await tick(); leads.find((x) => x.id === id).status = status; },
    },
    jobs: {
      async board(from, to) { await tick(); return jobs.filter((j) => j.scheduled_date >= from && j.scheduled_date <= to).map(boardRow); },
      async get(id) {
        await tick();
        const j = jobs.find((x) => x.id === id);
        if (!j) throw new Error('Job not found');
        return {
          ...clone(j),
          customer: clone(customers.find((c) => c.id === j.customer_id)), address: clone(addresses.find((a) => a.id === j.address_id)),
          crew: clone(crews.find((c) => c.id === j.crew_id) ?? null), unit: clone(units.find((u) => u.id === j.unit_id) ?? null),
          items: clone(items.filter((i) => i.job_id === id).sort((a, b) => a.sort - b.sort)), quote: clone(leads.find((l) => l.id === j.quote_id) ?? null),
        };
      },
      async book({ quoteId, date, window, crewId, unitId }) {
        await tick();
        const q = leads.find((l) => l.id === quoteId);
        if (['booked', 'completed'].includes(q.status)) throw new Error(`quote is already ${q.status}`);
        return bookSync(quoteId, date, window, crewId, unitId);
      },
      async update(id, patch) { await tick(); Object.assign(jobs.find((j) => j.id === id), patch); },
      async complete(id) {
        await tick();
        const j = jobs.find((x) => x.id === id);
        j.status = 'completed';
        j.completed_at = new Date().toISOString();
        j.warranty_until = addDays(localDate(new Date(), businessTz), j.warranty_days);
        const q = leads.find((l) => l.id === j.quote_id);
        if (q) q.status = 'completed';
        return j.warranty_until;
      },
    },
    items: {
      async add(jobId, item) {
        await tick();
        if (item.unit_cents < 0 && item.price_key !== 'promo') throw new Error('Only the promo line can be negative.');
        const row = { id: uid(), job_id: jobId, from_estimate: false, sort: 500, created_at: new Date().toISOString(), ...item };
        items.push(row);
        return clone(row);
      },
      async update(id, patch) { await tick(); Object.assign(items.find((i) => i.id === id), patch); },
      async remove(id) { await tick(); items.splice(items.findIndex((i) => i.id === id), 1); },
    },
    addresses: { async update(id, patch) { await tick(); Object.assign(addresses.find((a) => a.id === id), patch); } },
    crews: {
      async list() { await tick(); return clone(crews); },
      async add(row) { await tick(); crews.push({ id: uid(), active: true, phone_e164: null, ...row }); },
      async update(id, patch) { await tick(); Object.assign(crews.find((c) => c.id === id), patch); },
    },
    units: {
      async list() { await tick(); return clone(units); },
      async add(row) { await tick(); if (units.some((u) => u.unit_no === row.unit_no)) throw new Error(`Truck ${row.unit_no} already exists.`); units.push({ id: uid(), active: true, ...row }); },
      async update(id, patch) { await tick(); Object.assign(units.find((u) => u.id === id), patch); },
    },
    priceBook: {
      async items() {
        return [...DEFAULT_PRICE_BOOK.addons.map((a) => ({ ...a, kind: 'addon' })), ...DEFAULT_PRICE_BOOK.per_sqft.map((a) => ({ ...a, kind: 'per_sqft' }))];
      },
    },
  };
}
