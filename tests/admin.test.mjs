// Admin app logic. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../admin/logic.js';

const NOW = new Date('2026-10-03T18:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

test('every lead status maps to exactly one inbox tab', () => {
  for (const s of ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost', 'cancelled']) {
    assert.equal(L.LEAD_TABS.filter((t) => t.statuses.includes(s)).length, 1, s);
  }
});

test('timeAgo', () => {
  assert.equal(L.timeAgo(minsAgo(0), NOW), 'just now');
  assert.equal(L.timeAgo(minsAgo(12), NOW), '12 min ago');
  assert.equal(L.timeAgo(minsAgo(150), NOW), '2 hr ago');
  assert.equal(L.timeAgo(minsAgo(60 * 30), NOW), 'yesterday');
  assert.equal(L.timeAgo(minsAgo(60 * 24 * 5), NOW), '5 days ago');
});

test('waiting leads float to the top, oldest waiting first', () => {
  const leads = [
    { id: 'fresh', status: 'new', created_at: minsAgo(5) },
    { id: 'old-contacted', status: 'contacted', created_at: minsAgo(500) },
    { id: 'waiting-2h', status: 'new', created_at: minsAgo(120) },
    { id: 'waiting-45m', status: 'new', created_at: minsAgo(45) },
  ];
  assert.deepEqual(L.sortLeads(leads, NOW).map((l) => l.id), ['waiting-2h', 'waiting-45m', 'fresh', 'old-contacted']);
});

test('itemsFromQuote mirrors SQL book_quote', () => {
  const items = L.itemsFromQuote({
    price_lines: [{ key: 'rooms', label: '3 rooms', total_cents: 11900 }, { key: 'addon_hall', label: 'Hallway', total_cents: 2500 }],
    est_discount_cents: 1500, promo_code: 'BLUE15',
  });
  assert.deepEqual(items.map((i) => [i.label, i.unit_cents]), [['3 rooms', 11900], ['Hallway', 2500], ['Online discount (BLUE15)', -1500]]);
  assert.equal(L.itemsTotal(items), 12900);
  assert.deepEqual(L.itemsFromQuote({ price_lines: null }), []);
});

test('needsReason: unchanged estimate lines do not, changes and additions do', () => {
  const orig = { qty: 1, unit_cents: 2500 };
  assert.equal(L.needsReason({ from_estimate: true, qty: 1, unit_cents: 2500 }, orig), false);
  assert.equal(L.needsReason({ from_estimate: true, qty: 1, unit_cents: 3500 }, orig), true);
  assert.equal(L.needsReason({ from_estimate: true, qty: 2, unit_cents: 2500 }, orig), true);
  assert.equal(L.needsReason({ from_estimate: false, qty: 1, unit_cents: 2500 }, null), true);
});

test('findConflicts flags a shared truck or crew in the same slot only', () => {
  const base = { scheduled_date: '2026-10-04', time_window: 'midday', status: 'scheduled' };
  const jobs = [
    { ...base, id: 'a', unit_id: 'u1', unit_no: '1', crew_id: 'c1', crew_name: 'Richard' },
    { ...base, id: 'b', unit_id: 'u1', unit_no: '1', crew_id: 'c2', crew_name: 'Marcus' },
    { ...base, id: 'c', time_window: 'morning', unit_id: 'u1', crew_id: 'c1' },
    { ...base, id: 'd', unit_id: 'u1', crew_id: 'c1', status: 'cancelled' },
  ];
  const out = L.findConflicts(jobs);
  assert.deepEqual([...out.keys()].sort(), ['a', 'b']);
  assert.deepEqual(out.get('a'), ['Truck 1 double-booked']);
});

test('slotClashes ignores the job being edited', () => {
  const jobs = [{ id: 'a', scheduled_date: '2026-10-04', time_window: 'midday', status: 'scheduled', unit_id: 'u1', crew_id: null }];
  const slot = { date: '2026-10-04', window: 'midday', crewId: '', unitId: 'u1' };
  assert.equal(L.slotClashes(jobs, slot).length, 1);
  assert.equal(L.slotClashes(jobs, slot, 'a').length, 0);
});

test('groupByDay returns every day, jobs in window order', () => {
  const jobs = [
    { id: 'x', scheduled_date: '2026-10-04', time_window: 'evening' },
    { id: 'y', scheduled_date: '2026-10-04', time_window: 'morning' },
  ];
  const days = L.groupByDay(jobs, '2026-10-03', 3);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(days[1].jobs.map((j) => j.id), ['y', 'x']);
});

test('leadSummary', () => {
  assert.equal(L.leadSummary({ service: 'carpet', est_total_cents: 12900 }), 'Carpet cleaning · $129');
  assert.equal(L.leadSummary({ service: 'water', est_total_cents: null }), 'Water extraction · priced on site');
});

test('formatSigned puts the minus before the dollar sign', () => {
  assert.equal(L.formatSigned(-1500), '−$15');
  assert.equal(L.formatSigned(2500), '$25');
});
