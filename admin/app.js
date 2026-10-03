// Richard's Inbox: leads, today's jobs, the week, and each job's firm price.
// Screens are plain functions that fetch, render HTML, then wire events.
import * as L from './logic.js';

const CFG = Object.assign({ supabaseUrl: '', supabaseAnonKey: '', businessTz: 'America/Chicago' }, window.RCC_ADMIN_CONFIG || {});
const SUPABASE_UMD = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const wantDemo = isLocal && new URLSearchParams(location.search).has('demo');

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => L.localDate(new Date(), CFG.businessTz);
const usd = L.formatUSD;

const STATUS_LABEL = {
  new: 'New', contacted: 'Contacted', quoted: 'Quoted', booked: 'Booked', completed: 'Completed', lost: 'Lost', cancelled: 'Cancelled',
  scheduled: 'Scheduled', in_progress: 'In progress',
};
const STATUS_CHIP = { new: 'info', booked: 'ok', scheduled: 'info', in_progress: 'warn', completed: 'ok', lost: '', cancelled: '' };
const statusChip = (s) => `<span class="chip ${STATUS_CHIP[s] ?? ''}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

let api;
let current = 0;          // increments per navigation; stale renders bail out
let listRoute = '#leads'; // where Back goes
let adminFor = null;      // email we've confirmed is an admin
let bootError = '';       // shown after the first screen loads

// ---------- small UI helpers ----------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}
function showError(msg) { const b = $('#errorBanner'); b.textContent = msg; b.hidden = !msg; }

function paint(token, { title, html, back = null }) {
  if (token !== current) return false;
  $('#screenTitle').textContent = title;
  const backLink = $('#backLink');
  backLink.hidden = !back;
  if (back) backLink.href = back;
  app.innerHTML = html;
  return true;
}

function setTab(name) {
  const map = { leads: 'leads', today: 'today', week: 'week', setup: 'setup' };
  $$('#tabbar a').forEach((a) => {
    if (a.dataset.tab === map[name]) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function parseDollars(str) {
  const s = String(str).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}
const dollars = (cents) => (cents / 100).toFixed(2).replace(/\.00$/, '');

async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try { await fn(); } catch (e) { showError(e.message); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
}

async function rerender() {
  const y = scrollY;
  await route();
  scrollTo(0, y);
}

function windowOptions(selected) {
  return L.WINDOWS.map((w) => `<option value="${w.key}" ${w.key === selected ? 'selected' : ''}>${w.label} (${w.hours})</option>`).join('');
}
function pickOptions(rows, selected, labelFn, none) {
  return `<option value="">${none}</option>` + rows.filter((r) => r.active || r.id === selected)
    .map((r) => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(labelFn(r))}</option>`).join('');
}

// Live warning when a slot already has the same truck or crew.
function wireClashCheck(form, ignoreJobId = null) {
  const box = $('.clash', form);
  const check = async () => {
    const date = form.elements.date.value;
    if (!date) { box.hidden = true; return; }
    const jobs = await api.jobs.board(date, date);
    const clashes = L.slotClashes(jobs, { date, window: form.elements.window.value, crewId: form.elements.crew.value, unitId: form.elements.unit.value }, ignoreJobId);
    box.hidden = !clashes.length;
    box.textContent = clashes.length
      ? `Heads up: ${clashes.map((j) => `${j.customer_name} (${[j.crew_name, j.unit_no && 'truck ' + j.unit_no].filter(Boolean).join(', ')})`).join('; ')} already in this slot.`
      : '';
  };
  ['date', 'window', 'crew', 'unit'].forEach((n) => form.elements[n].addEventListener('change', check));
  check();
}

// ---------- screens ----------

function renderNotConfigured() {
  $('#screenTitle').textContent = "Richard's Inbox";
  app.innerHTML = `<div class="login card stack"><h2>Not connected yet</h2>
    <p class="muted">Fill in <code>admin/config.js</code> with the Supabase URL and anon key. SETUP.md walks through it.</p>
    ${isLocal ? '<a class="btn primary" href="?demo#leads">Open the demo</a>' : ''}</div>`;
}

function renderLogin(token) {
  $('#tabbar').hidden = true;
  if (!paint(token, { title: "Richard's Inbox", html: `
    <div class="login card stack">
      <h2>Sign in</h2>
      <p class="muted">Enter the email Jay set up for you. We'll send a sign-in link, so there's no password to remember. Open the link on this phone.</p>
      <form id="loginForm" class="stack">
        <label class="f">Email<input id="loginEmail" type="email" autocomplete="email" inputmode="email" required></label>
        <button class="btn primary" type="submit">Email me a sign-in link</button>
      </form>
      <div id="loginMsg" hidden></div>
    </div>` })) return;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#loginMsg');
    const btn = $('#loginForm button');
    btn.disabled = true;
    try {
      await api.auth.sendLink($('#loginEmail').value.trim());
      msg.className = 'okbox';
      msg.textContent = 'Check your email for the sign-in link. It expires in an hour.';
    } catch (err) {
      msg.className = 'warnbox';
      msg.textContent = /signups not allowed|not found|user/i.test(err.message)
        ? "That email isn't set up for the inbox. Ask Jay to add it."
        : `Couldn't send the link: ${err.message}`;
    } finally {
      msg.hidden = false;
      btn.disabled = false;
    }
  });
}

function renderNotAdmin(token, session) {
  $('#tabbar').hidden = true;
  if (!paint(token, { title: "Richard's Inbox", html: `
    <div class="login card stack">
      <h2>No access</h2>
      <p>You're signed in as <strong>${esc(session.email)}</strong>, but this account isn't set up for the inbox. Ask Jay to add it.</p>
      <button class="btn" id="signOut" type="button">Sign out</button>
    </div>` })) return;
  $('#signOut').addEventListener('click', () => api.auth.signOut());
}

async function renderLeads(token, tab) {
  const now = new Date();
  const leads = await api.leads.list();
  const counts = Object.fromEntries(L.LEAD_TABS.map((t) => [t.key, leads.filter((l) => L.tabForStatus(l.status) === t.key).length]));
  updateBadge(counts.new);
  const shown = L.sortLeads(leads.filter((l) => L.tabForStatus(l.status) === tab), now);

  const seg = `<nav class="seg" aria-label="Lead status">${L.LEAD_TABS.map((t) =>
    `<a href="#leads/${t.key}" ${t.key === tab ? 'aria-current="true"' : ''}>${t.label}<span class="n">${counts[t.key]}</span></a>`).join('')}</nav>`;

  const rows = shown.map((l) => {
    const waiting = L.isWaiting(l, now);
    const urgent = l.service === 'water' && ['new', 'contacted'].includes(l.status);
    const chips = [
      urgent && '<span class="chip urgent">Urgent: water</span>',
      waiting && `<span class="chip urgent">Waiting ${esc(L.timeAgo(l.created_at, now).replace(' ago', ''))}</span>`,
      tab !== 'new' && statusChip(l.status),
      `<span class="chip">Wants ${esc(L.prettyDate(l.preferred_date))}</span>`,
      `<span class="chip">${esc(l.address?.zip ?? '')}</span>`,
      l.address?.in_service_area === false && '<span class="chip warn">Outside area</span>',
    ].filter(Boolean).join('');
    return `<a class="row ${waiting || urgent ? 'flag' : ''}" href="#lead/${l.id}">
      <div class="row-top"><span class="row-name">${esc(l.customer?.name)}</span><span class="muted small">${esc(L.timeAgo(l.created_at, now))}</span></div>
      <div class="row-sub">${esc(L.leadSummary(l))}</div>
      <div class="chips">${chips}</div></a>`;
  }).join('');

  const emptyText = { new: 'No new leads. New requests from the website show up here.', working: 'Nothing in progress.', booked: 'No booked leads.', closed: 'Nothing closed yet.' }[tab];
  paint(token, { title: 'Leads', html: seg + `<div class="list">${rows || `<div class="empty">${emptyText}</div>`}</div>` });
}

function updateBadge(n) {
  const b = $('#newBadge');
  b.hidden = !n;
  b.textContent = n;
}

async function renderLead(token, id) {
  const [lead, crews, units] = await Promise.all([api.leads.get(id), api.crews.list(), api.units.list()]);
  const c = lead.customer, a = lead.address;
  const lines = lead.price_lines ?? [];
  const estimate = lead.est_total_cents != null
    ? `<table class="lines">${lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="amt">${usd(l.total_cents)}</td></tr>`).join('')}
        ${lead.est_discount_cents ? `<tr><td>Online discount (${esc(lead.promo_code)})</td><td class="amt">−${usd(lead.est_discount_cents)}</td></tr>` : ''}
        <tr class="total"><td>Estimate</td><td class="amt">${usd(lead.est_total_cents)}</td></tr></table>`
    : '<p class="muted">Priced on site. No online estimate.</p>';

  const open = ['new', 'contacted', 'quoted'].includes(lead.status);
  const statusButtons = [
    lead.status === 'new' && '<button class="btn" data-status="contacted" type="button">Mark contacted</button>',
    lead.status === 'contacted' && '<button class="btn" data-status="quoted" type="button">Mark quoted</button>',
    open && '<button class="btn danger" data-status="lost" type="button">Mark lost</button>',
    ['lost', 'cancelled'].includes(lead.status) && '<button class="btn" data-status="contacted" type="button">Reopen</button>',
  ].filter(Boolean).join('');

  const defaultDate = lead.preferred_date >= today() ? lead.preferred_date : today();
  const html = `
    <section class="card">
      <h2>${esc(c.name)}</h2>
      <div class="chips">${statusChip(lead.status)}${lead.service === 'water' ? '<span class="chip urgent">Urgent: water</span>' : ''}
        ${a?.in_service_area === false ? '<span class="chip warn">Outside service area</span>' : ''}</div>
      <div class="actions three">
        <a class="btn dark" href="${L.telHref(c.phone_e164)}">Call</a>
        <a class="btn dark" href="${L.smsHref(c.phone_e164)}">Text</a>
        <a class="btn" href="${L.mapUrl(a?.line1 ?? '', a?.zip ?? '')}" target="_blank" rel="noopener">Map</a>
      </div>
      <dl class="facts">
        <dt>Phone</dt><dd>${esc(L.formatPhone(c.phone_e164))}</dd>
        ${c.email ? `<dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>` : ''}
        <dt>Address</dt><dd>${esc(a?.line1)}, ${esc(a?.zip)}</dd>
        <dt>Service</dt><dd>${esc(L.SERVICES[lead.service] ?? lead.service)}</dd>
        <dt>Wants</dt><dd>${esc(L.prettyDate(lead.preferred_date, { weekday: 'long' }))}</dd>
        <dt>Sent</dt><dd>${esc(new Date(lead.created_at).toLocaleString('en-US', { timeZone: CFG.businessTz, dateStyle: 'medium', timeStyle: 'short' }))}</dd>
      </dl>
      ${lead.notes ? `<p><strong>Notes:</strong> ${esc(lead.notes)}</p>` : ''}
    </section>

    <section class="card"><h3>Online estimate</h3>${estimate}</section>

    ${lead.job_id ? `<a class="btn primary" href="#job/${lead.job_id}">Open the job</a>` : ''}
    ${open ? '<button class="btn primary" id="showBook" type="button">Book a job</button>' : ''}

    <section class="card" id="bookSheet" hidden>
      <h3>Book this job</h3>
      <form id="bookForm" class="stack">
        <div class="two">
          <label class="f">Date<input name="date" type="date" min="${today()}" value="${defaultDate}" required></label>
          <label class="f">Time<select name="window">${windowOptions('morning')}</select></label>
        </div>
        <div class="two">
          <label class="f">Crew<select name="crew">${pickOptions(crews, crews.find((x) => x.active)?.id, (r) => r.name, 'Not assigned')}</select></label>
          <label class="f">Truck<select name="unit">${pickOptions(units, units.find((x) => x.active)?.id, (r) => `Truck ${r.unit_no}`, 'Not assigned')}</select></label>
        </div>
        <div class="clash warnbox" hidden></div>
        <button class="btn primary" type="submit">Book it</button>
      </form>
    </section>

    ${statusButtons ? `<div class="actions">${statusButtons}</div>` : ''}

    ${lead.messages?.length ? `<section class="card"><h3>Texts and emails</h3><table class="lines">${lead.messages.map((m) =>
      `<tr><td>${esc(m.channel.toUpperCase())} ${m.direction === 'in' ? 'from' : 'to'} ${esc(m.direction === 'in' ? m.from_addr : m.to_addr)}
        <span class="${m.status === 'failed' ? 'reason' : 'muted small'}" style="display:block">${esc(m.status)}${m.error ? ': ' + esc(m.error) : ''}</span></td>
        <td class="amt muted small">${esc(new Date(m.created_at).toLocaleString('en-US', { timeZone: CFG.businessTz, timeStyle: 'short', dateStyle: 'short' }))}</td></tr>`).join('')}</table></section>` : ''}`;

  if (!paint(token, { title: 'Lead', html, back: listRoute.startsWith('#leads') ? listRoute : '#leads' })) return;

  $$('[data-status]').forEach((btn) => btn.addEventListener('click', () => busy(btn, async () => {
    await api.leads.setStatus(id, btn.dataset.status);
    toast(`Marked ${STATUS_LABEL[btn.dataset.status].toLowerCase()}`);
    await rerender();
  })));

  const show = $('#showBook');
  if (show) {
    show.addEventListener('click', () => {
      $('#bookSheet').hidden = false;
      show.hidden = true;
      $('#bookSheet').scrollIntoView({ block: 'start' });
    });
    const form = $('#bookForm');
    wireClashCheck(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      busy($('button[type="submit"]', form), async () => {
        const jobId = await api.jobs.book({ quoteId: id, date: f.date.value, window: f.window.value, crewId: f.crew.value, unitId: f.unit.value });
        toast(`Booked for ${L.prettyDate(f.date.value)}`);
        location.hash = `#job/${jobId}`;
      });
    });
  }
}

function jobRow(j, conflicts) {
  const where = [j.crew_name, j.unit_no && `Truck ${j.unit_no}`].filter(Boolean).join(' · ') || 'No crew or truck assigned';
  const clash = conflicts?.get(j.id);
  return `<a class="row ${clash ? 'flag' : ''}" href="#job/${j.id}">
    <div class="row-top"><span class="row-name">${esc(L.windowLabel(j.time_window))} · ${esc(j.customer_name)}</span><span class="muted small">${usd(j.firm_total_cents)}</span></div>
    <div class="row-sub">${esc(j.line1 ?? '')}${j.zip ? ', ' + esc(j.zip) : ''}</div>
    <div class="chips">${statusChip(j.status)}<span class="chip">${esc(where)}</span>
      ${j.service ? `<span class="chip">${esc(L.SERVICES[j.service] ?? j.service)}</span>` : ''}
      ${(clash ?? []).map((c) => `<span class="chip urgent">${esc(c)}</span>`).join('')}</div>
    ${j.access_notes ? `<div class="row-sub small" style="margin-top:6px">Access: ${esc(j.access_notes)}</div>` : ''}
  </a>`;
}

async function renderToday(token) {
  const d = today();
  const jobs = (await api.jobs.board(d, d)).filter((j) => j.status !== 'cancelled')
    .sort((a, b) => L.windowOrder(a.time_window) - L.windowOrder(b.time_window));
  const conflicts = L.findConflicts(jobs);
  const left = jobs.filter((j) => j.status !== 'completed').length;
  paint(token, { title: 'Today', html: `
    <div class="day-head"><h2>${esc(L.prettyDate(d, { weekday: 'long' }))}</h2><span class="muted small">${jobs.length} job${jobs.length === 1 ? '' : 's'}${jobs.length ? `, ${left} left` : ''}</span></div>
    <div class="list">${jobs.map((j) => jobRow(j, conflicts)).join('') || '<div class="empty">No jobs today.</div>'}</div>` });
}

async function renderWeek(token) {
  const from = today();
  const to = L.addDays(from, 6);
  const jobs = (await api.jobs.board(from, to)).filter((j) => j.status !== 'cancelled');
  const conflicts = L.findConflicts(jobs);
  const days = L.groupByDay(jobs, from, 7);
  const weekday = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const label = (d, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : weekday(d));
  paint(token, { title: 'Week', html: days.map((day, i) => `
    <section class="day">
      <div class="day-head"><h2>${esc(label(day.date, i))}</h2><span class="muted small">${esc(L.prettyDate(day.date))} · ${day.jobs.length || 'nothing'} booked</span></div>
      <div class="list">${day.jobs.map((j) => jobRow(j, conflicts)).join('') || '<div class="empty">Open day</div>'}</div>
    </section>`).join('') });
}

function checklistKey(jobId) { return `rcc-checklist-${jobId}`; }
function loadChecks(jobId) { try { return JSON.parse(localStorage.getItem(checklistKey(jobId)) || '{}'); } catch { return {}; } }
function saveChecks(jobId, v) { try { localStorage.setItem(checklistKey(jobId), JSON.stringify(v)); } catch { /* private mode */ } }

async function renderJob(token, id) {
  const [job, crews, units, pb] = await Promise.all([api.jobs.get(id), api.crews.list(), api.units.list(), api.priceBook.items()]);
  const c = job.customer, a = job.address, q = job.quote;
  const locked = ['completed', 'cancelled'].includes(job.status);
  const firm = L.itemsTotal(job.items);
  const est = q?.est_total_cents;

  const originalFor = (item) => {
    if (!item.from_estimate) return null;
    if (item.price_key === 'promo') return { qty: 1, unit_cents: -(q?.est_discount_cents ?? 0) };
    const l = q?.price_lines?.find((x) => x.key === item.price_key);
    return l ? { qty: 1, unit_cents: l.total_cents } : null;
  };

  const itemRows = job.items.map((i) => `
    <tr><td><button class="linkish" type="button" data-edit="${i.id}" ${locked ? 'disabled' : ''}>
      ${esc(i.label)}${i.qty > 1 ? ` <span class="muted">× ${i.qty} @ ${L.formatSigned(i.unit_cents)}</span>` : ''}
      ${i.adjust_reason ? `<span class="reason">${esc(i.adjust_reason)}</span>` : ''}</button></td>
      <td class="amt">${L.formatSigned(L.lineTotal(i))}</td></tr>`).join('');

  const diff = est != null ? firm - est : null;
  const checks = loadChecks(job.id);

  const statusBlock = {
    scheduled: `<div class="actions"><button class="btn primary" id="startJob" type="button">Start job</button><button class="btn danger" id="cancelJob" type="button">Cancel job</button></div>`,
    in_progress: `<button class="btn primary" id="completeJob" type="button">Mark complete</button>`,
    completed: `<div class="okbox">Completed ${esc(new Date(job.completed_at).toLocaleDateString('en-US', { timeZone: CFG.businessTz, month: 'short', day: 'numeric' }))}. Re-clean guarantee until ${esc(L.prettyDate(job.warranty_until, { weekday: 'long' }))}.</div>`,
    cancelled: '<div class="warnbox">This job was cancelled.</div>',
  }[job.status];

  const html = `
    <section class="card">
      <h2>${esc(c.name)}</h2>
      <div class="chips">${statusChip(job.status)}<span class="chip">${esc(L.prettyDate(job.scheduled_date))} · ${esc(L.windowLabel(job.time_window))}</span>
        <span class="chip">${esc([job.crew?.name, job.unit && 'Truck ' + job.unit.unit_no].filter(Boolean).join(' · ') || 'Unassigned')}</span></div>
      <div class="actions three">
        <a class="btn dark" href="${L.telHref(c.phone_e164)}">Call</a>
        <a class="btn dark" href="${L.smsHref(c.phone_e164)}">Text</a>
        <a class="btn" href="${L.mapUrl(a?.line1 ?? '', a?.zip ?? '')}" target="_blank" rel="noopener">Map</a>
      </div>
      <dl class="facts"><dt>Address</dt><dd>${esc(a?.line1)}, ${esc(a?.zip)}</dd>
        ${a?.access_notes ? `<dt>Access</dt><dd>${esc(a.access_notes)}</dd>` : ''}
        ${q?.notes ? `<dt>Customer</dt><dd>${esc(q.notes)}</dd>` : ''}</dl>
      <div style="margin-top:12px">${statusBlock}</div>
      <div id="confirmBox" hidden></div>
    </section>

    <section class="card">
      <h3>Firm price</h3>
      ${job.items.length ? `<table class="lines">${itemRows}<tr class="total"><td>Total before tax</td><td class="amt">${usd(firm)}</td></tr></table>`
        : '<p class="muted">No line items yet. Add what you price on site.</p>'}
      ${est != null ? `<p class="muted small">Online estimate ${usd(est)}${diff ? ` · ${diff > 0 ? '+' : '−'}${usd(Math.abs(diff))} on site` : ' · matches'}</p>` : ''}
      <div id="itemEditor"></div>
      ${locked ? '' : '<button class="btn quiet" id="addItemBtn" type="button">Add a line</button>'}
    </section>

    ${job.items.some((i) => i.price_key !== 'promo') ? `<section class="card"><h3>On-site checklist</h3>
      ${job.items.filter((i) => i.price_key !== 'promo').map((i) => `<label class="check"><input type="checkbox" data-check="${i.id}" ${checks[i.id] ? 'checked' : ''}> ${esc(i.label)}</label>`).join('')}
      <label class="check"><input type="checkbox" data-check="walk" ${checks.walk ? 'checked' : ''}> Walk-through with the customer</label>
    </section>` : ''}

    <section class="card">
      <h3>Schedule</h3>
      <form id="schedForm" class="stack">
        <div class="two">
          <label class="f">Date<input name="date" type="date" value="${job.scheduled_date}" ${locked ? 'disabled' : ''}></label>
          <label class="f">Time<select name="window" ${locked ? 'disabled' : ''}>${windowOptions(job.time_window)}</select></label>
        </div>
        <div class="two">
          <label class="f">Crew<select name="crew" ${locked ? 'disabled' : ''}>${pickOptions(crews, job.crew_id, (r) => r.name, 'Not assigned')}</select></label>
          <label class="f">Truck<select name="unit" ${locked ? 'disabled' : ''}>${pickOptions(units, job.unit_id, (r) => `Truck ${r.unit_no}`, 'Not assigned')}</select></label>
        </div>
        <div class="clash warnbox" hidden></div>
        ${locked ? '' : '<button class="btn" type="submit">Save schedule</button>'}
      </form>
    </section>

    <section class="card">
      <h3>Notes</h3>
      <form id="notesForm" class="stack">
        <label class="f">Access (gate code, parking, pets)<textarea name="access">${esc(a?.access_notes ?? '')}</textarea></label>
        <label class="f">Job notes<textarea name="notes">${esc(job.notes ?? '')}</textarea></label>
        <button class="btn" type="submit">Save notes</button>
      </form>
    </section>

    ${q ? `<a class="btn quiet" href="#lead/${q.id}">View the original request</a>` : ''}`;

  if (!paint(token, { title: 'Job', html, back: listRoute.startsWith('#leads') && q ? `#lead/${q.id}` : listRoute })) return;

  // status
  $('#startJob')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await api.jobs.update(id, { status: 'in_progress' }); toast('Job started'); await rerender(); }));
  $('#completeJob')?.addEventListener('click', () => {
    const box = $('#confirmBox');
    box.hidden = false;
    box.innerHTML = `<div class="warnbox" style="margin-top:12px">Mark complete at ${usd(firm)}? This starts the ${job.warranty_days}-day re-clean guarantee.</div>
      <div class="actions"><button class="btn primary" id="yesComplete" type="button">Yes, complete</button><button class="btn quiet" id="noComplete" type="button">Not yet</button></div>`;
    $('#noComplete').addEventListener('click', () => { box.hidden = true; });
    $('#yesComplete').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const until = await api.jobs.complete(id);
      toast(`Done. Guarantee until ${L.prettyDate(until)}`);
      await rerender();
    }));
  });
  $('#cancelJob')?.addEventListener('click', () => {
    const box = $('#confirmBox');
    box.hidden = false;
    box.innerHTML = `<div class="warnbox" style="margin-top:12px">Cancel this job? The lead moves to Closed.</div>
      <div class="actions"><button class="btn danger" id="yesCancel" type="button">Yes, cancel it</button><button class="btn quiet" id="noCancel" type="button">Keep it</button></div>`;
    $('#noCancel').addEventListener('click', () => { box.hidden = true; });
    $('#yesCancel').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      await api.jobs.update(id, { status: 'cancelled' });
      if (q) await api.leads.setStatus(q.id, 'cancelled');
      toast('Job cancelled');
      await rerender();
    }));
  });

  // line items
  const editor = $('#itemEditor');
  const closeEditor = () => { editor.innerHTML = ''; };

  $$('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const item = job.items.find((i) => i.id === btn.dataset.edit);
    const orig = originalFor(item);
    editor.innerHTML = `<form class="stack card" id="editForm" style="margin-top:12px;background:var(--paper)">
      <label class="f">Line<input name="label" value="${esc(item.label)}" ${item.from_estimate ? 'readonly' : ''}></label>
      <div class="two">
        <label class="f">Qty<input name="qty" type="number" min="1" step="1" inputmode="numeric" value="${item.qty}"></label>
        <label class="f">Price each ($)<input name="price" inputmode="decimal" value="${dollars(item.unit_cents)}"></label>
      </div>
      ${orig ? `<p class="muted small" style="margin:0">Quoted online: ${L.formatSigned(orig.unit_cents)}</p>` : ''}
      <label class="f">Reason for the change<textarea name="reason" placeholder="e.g. Heavier staining than described">${esc(item.adjust_reason ?? '')}</textarea></label>
      <div class="formErr warnbox" hidden></div>
      <div class="actions three"><button class="btn primary" type="submit">Save</button><button class="btn danger" type="button" id="removeItem">Remove</button><button class="btn quiet" type="button" id="closeEdit">Close</button></div>
    </form>`;
    const form = $('#editForm');
    const err = $('.formErr', form);
    $('#closeEdit').addEventListener('click', closeEditor);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const qty = Number(form.elements.qty.value);
      const unit = parseDollars(form.elements.price.value);
      const reason = form.elements.reason.value.trim();
      const next = { ...item, qty, unit_cents: unit };
      const problem = !Number.isInteger(qty) || qty < 1 ? 'Qty must be a whole number, 1 or more.'
        : Number.isNaN(unit) ? 'Enter a price like 45 or 45.50.'
        : unit < 0 && item.price_key !== 'promo' ? 'Only the online discount can be negative.'
        : L.needsReason(next, orig) && !reason ? 'Add a reason. The customer was quoted a different price online.' : '';
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      busy($('button[type="submit"]', form), async () => {
        await api.items.update(item.id, { qty, unit_cents: unit, label: form.elements.label.value.trim() || item.label, adjust_reason: reason || null });
        toast('Line updated');
        await rerender();
      });
    });
    $('#removeItem').addEventListener('click', (e) => {
      const reason = form.elements.reason.value.trim();
      if (!reason) { err.textContent = 'Add a reason before removing a line, so there is a record of it.'; err.hidden = false; return; }
      busy(e.currentTarget, async () => {
        const stamp = L.prettyDate(today());
        const note = `${stamp}: removed "${item.label}" (${L.formatSigned(L.lineTotal(item))}). ${reason}`;
        await api.items.remove(item.id);
        await api.jobs.update(id, { notes: [job.notes, note].filter(Boolean).join('\n') });
        toast('Line removed');
        await rerender();
      });
    });
    form.scrollIntoView({ block: 'nearest' });
  }));

  $('#addItemBtn')?.addEventListener('click', () => {
    editor.innerHTML = `<form class="stack card" id="addForm" style="margin-top:12px;background:var(--paper)">
      <label class="f">What<select name="key">${pb.map((p) => `<option value="${esc(p.key)}" data-cents="${p.amount_cents}" data-label="${esc(p.label)}">${esc(p.label)} (${usd(p.amount_cents)}${p.kind === 'per_sqft' ? '/sq ft' : ''})</option>`).join('')}<option value="">Custom line…</option></select></label>
      <label class="f" id="customLabel" hidden>Description<input name="label" placeholder="e.g. Extra closet"></label>
      <div class="two">
        <label class="f"><span id="qtyLabel">Qty</span><input name="qty" type="number" min="1" step="1" inputmode="numeric" value="1"></label>
        <label class="f">Price each ($)<input name="price" inputmode="decimal"></label>
      </div>
      <label class="f">Reason<textarea name="reason" placeholder="e.g. Customer added the stairs on site"></textarea></label>
      <div class="formErr warnbox" hidden></div>
      <div class="actions"><button class="btn primary" type="submit">Add line</button><button class="btn quiet" type="button" id="closeAdd">Close</button></div>
    </form>`;
    const form = $('#addForm');
    const err = $('.formErr', form);
    const sync = () => {
      const opt = form.elements.key.selectedOptions[0];
      const custom = !opt.value;
      $('#customLabel').hidden = !custom;
      $('#qtyLabel').textContent = opt.value.endsWith('_sqft') ? 'Square feet' : 'Qty';
      form.elements.price.value = custom ? '' : dollars(Number(opt.dataset.cents));
    };
    form.elements.key.addEventListener('change', sync);
    sync();
    $('#closeAdd').addEventListener('click', closeEditor);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const opt = form.elements.key.selectedOptions[0];
      const qty = Number(form.elements.qty.value);
      const unit = parseDollars(form.elements.price.value);
      const label = opt.value ? opt.dataset.label : form.elements.label.value.trim();
      const reason = form.elements.reason.value.trim();
      const problem = !label ? 'Describe the custom line.'
        : !Number.isInteger(qty) || qty < 1 ? 'Qty must be a whole number, 1 or more.'
        : Number.isNaN(unit) || unit < 0 ? 'Enter a price like 45 or 45.50.'
        : !reason ? 'Add a reason. Anything added on site needs one.' : '';
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      busy($('button[type="submit"]', form), async () => {
        await api.items.add(id, { price_key: opt.value || null, label, qty, unit_cents: unit, adjust_reason: reason, from_estimate: false, sort: 500 });
        toast('Line added');
        await rerender();
      });
    });
    form.scrollIntoView({ block: 'nearest' });
  });

  // checklist (this phone only)
  $$('[data-check]').forEach((box) => box.addEventListener('change', () => {
    const v = loadChecks(job.id);
    v[box.dataset.check] = box.checked;
    saveChecks(job.id, v);
  }));

  // schedule
  const sched = $('#schedForm');
  if (!locked) {
    wireClashCheck(sched, job.id);
    sched.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = sched.elements;
      busy($('button[type="submit"]', sched), async () => {
        await api.jobs.update(id, { scheduled_date: f.date.value, time_window: f.window.value, crew_id: f.crew.value || null, unit_id: f.unit.value || null });
        toast('Schedule saved');
        await rerender();
      });
    });
  }

  // notes
  const notes = $('#notesForm');
  notes.addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button[type="submit"]', notes), async () => {
      if (a) await api.addresses.update(a.id, { access_notes: notes.elements.access.value.trim() || null });
      await api.jobs.update(id, { notes: notes.elements.notes.value.trim() || null });
      toast('Notes saved');
      await rerender();
    });
  });
}

async function renderSetup(token, session) {
  const [crews, units] = await Promise.all([api.crews.list(), api.units.list()]);
  const html = `
    <section class="card">
      <h3>Crew</h3>
      <div class="list">${crews.map((c) => `<div class="row"><div class="row-top"><span class="row-name">${esc(c.name)}</span>
        <button class="btn quiet" style="width:auto" data-crew="${c.id}" data-active="${c.active}" type="button">${c.active ? 'Active' : 'Inactive'}</button></div></div>`).join('') || '<div class="empty">No crew yet. Add yourself first.</div>'}</div>
      <form id="crewForm" class="stack" style="margin-top:12px">
        <label class="f">Name<input name="name" placeholder="e.g. Richard" required></label>
        <button class="btn" type="submit">Add crew member</button>
      </form>
    </section>

    <section class="card">
      <h3>Trucks</h3>
      <div class="list">${units.map((u) => `<div class="row"><div class="row-top"><span class="row-name">Truck ${esc(u.unit_no)}</span>
        <button class="btn quiet" style="width:auto" data-unit="${u.id}" data-active="${u.active}" type="button">${u.active ? 'Active' : 'Inactive'}</button></div>
        <div class="row-sub">${esc(u.description ?? '')}</div>
        <form class="two" data-service-form="${u.id}" style="margin-top:8px"><input name="last" type="date" value="${u.last_service_on ?? ''}" aria-label="Last service date for truck ${esc(u.unit_no)}"><button class="btn quiet" type="submit">Save service date</button></form>
        </div>`).join('') || '<div class="empty">No trucks yet.</div>'}</div>
      <form id="unitForm" class="stack" style="margin-top:12px">
        <div class="two"><label class="f">Truck number<input name="unit_no" placeholder="e.g. 1" required></label>
        <label class="f">Description<input name="description" placeholder="e.g. Blue Kohler unit"></label></div>
        <button class="btn" type="submit">Add truck</button>
      </form>
    </section>

    <section class="card">
      <h3>Account</h3>
      <p>Signed in as <strong>${esc(session.email)}</strong>.</p>
      <button class="btn" id="signOutBtn" type="button">Sign out</button>
    </section>`;
  if (!paint(token, { title: 'Setup', html })) return;

  $$('[data-crew]').forEach((b) => b.addEventListener('click', () => busy(b, async () => { await api.crews.update(b.dataset.crew, { active: b.dataset.active !== 'true' }); await rerender(); })));
  $$('[data-unit]').forEach((b) => b.addEventListener('click', () => busy(b, async () => { await api.units.update(b.dataset.unit, { active: b.dataset.active !== 'true' }); await rerender(); })));
  $$('[data-service-form]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button', f), async () => { await api.units.update(f.dataset.serviceForm, { last_service_on: f.elements.last.value || null }); toast('Saved'); });
  }));
  $('#crewForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    busy($('button', f), async () => { await api.crews.add({ name: f.elements.name.value.trim() }); toast('Crew added'); await rerender(); });
  });
  $('#unitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    busy($('button', f), async () => {
      await api.units.add({ unit_no: f.elements.unit_no.value.trim(), description: f.elements.description.value.trim() || null });
      toast('Truck added');
      await rerender();
    });
  });
  $('#signOutBtn').addEventListener('click', () => api.auth.signOut());
}

// ---------- router ----------

async function route() {
  const token = ++current;
  showError(bootError);
  bootError = '';
  try {
    const session = await api.auth.session();
    if (!session) { adminFor = null; return renderLogin(token); }
    if (adminFor !== session.email) {
      if (!(await api.auth.isAdmin())) return renderNotAdmin(token, session);
      adminFor = session.email;
    }
    $('#tabbar').hidden = false;
    const [name, arg] = (location.hash.slice(1) || 'leads').split('/');
    if (['leads', 'today', 'week'].includes(name)) listRoute = location.hash || '#leads';
    setTab(name === 'lead' ? 'leads' : name === 'job' ? listRoute.slice(1).split('/')[0] : name);
    switch (name) {
      case 'lead': return await renderLead(token, arg);
      case 'job': return await renderJob(token, arg);
      case 'today': return await renderToday(token);
      case 'week': return await renderWeek(token);
      case 'setup': return await renderSetup(token, session);
      default: return await renderLeads(token, L.LEAD_TABS.some((t) => t.key === arg) ? arg : 'new');
    }
  } catch (e) {
    if (token === current) { showError(e.message); app.innerHTML = '<p class="muted pad">Couldn\'t load this screen. Check the connection and tap ↻.</p>'; }
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the sign-in library. Check the connection.'));
    document.head.appendChild(s);
  });
}

async function boot() {
  try {
    if (wantDemo) {
      const { makeDemoApi } = await import('./api-demo.js');
      api = makeDemoApi(CFG);
      $('#demoBanner').hidden = false;
    } else if (CFG.supabaseUrl && CFG.supabaseAnonKey) {
      await loadScript(SUPABASE_UMD);
      const { makeSupabaseApi } = await import('./api-supabase.js');
      api = makeSupabaseApi(CFG);
    } else {
      return renderNotConfigured();
    }
  } catch (e) {
    return showError(e.message);
  }

  // Magic-link redirects land with tokens (or an error) in the hash.
  if (/access_token=|error_description=/.test(location.hash)) {
    const err = new URLSearchParams(location.hash.slice(1)).get('error_description');
    await api.auth.session();
    history.replaceState(null, '', location.pathname + location.search + '#leads');
    if (err) bootError = `Sign-in link problem: ${err}. Request a new link.`;
  }

  api.auth.onChange(() => route());
  addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') route(); });
  $('#refreshBtn').addEventListener('click', () => route());
  route();
}

boot();
