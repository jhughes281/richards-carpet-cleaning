// Richard's Carpet Cleaning: page behaviour.
// Pricing and validation are the same modules the server runs, so the
// estimate a customer sees is the estimate Richard receives.
import {
  DEFAULT_PRICE_BOOK, quote, packageSelection, describeSelection, formatUSD, roomsCents, MAX_ROOMS, ESTIMABLE_SERVICES,
} from '../supabase/functions/_shared/pricing.js';
import { validateQuoteRequest, localDate } from '../supabase/functions/_shared/validate.js';

const CFG = Object.assign(
  { functionsUrl: '', turnstileSiteKey: '', businessTz: 'America/Chicago', phoneDisplay: '(555) 234-8765' },
  window.RCC_CONFIG || {},
);
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollBehavior = reduceMotion ? 'auto' : 'smooth';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

let book = DEFAULT_PRICE_BOOK;

// ---------- prices on the page ----------

function itemCents(key) {
  if (key === 'room_first') return book.rooms.first_cents;
  if (key === 'room_additional') return book.rooms.additional_cents;
  return [...book.addons, ...book.per_sqft].find((x) => x.key === key)?.amount_cents;
}

function renderPrices() {
  $$('[data-price]').forEach((el) => {
    const c = itemCents(el.dataset.price);
    if (c != null) el.textContent = (el.dataset.prefix || '') + formatUSD(c);
  });
  $$('[data-price-rooms]').forEach((el) => { el.textContent = formatUSD(roomsCents(book, Number(el.dataset.priceRooms))); });
  $$('[data-pkg-price]').forEach((el) => {
    const sel = packageSelection(book, el.dataset.pkgPrice);
    if (sel) el.textContent = formatUSD(quote(book, sel).total_cents);
  });
  $$('[data-pkg-summary]').forEach((el) => {
    const sel = packageSelection(book, el.dataset.pkgSummary);
    if (sel) el.textContent = cap(describeSelection(book, sel));
  });
  $$('[data-pkg-warranty]').forEach((el) => {
    const pkg = book.packages.find((p) => p.key === el.dataset.pkgWarranty);
    if (pkg) el.textContent = pkg.warranty_days;
  });
  $$('[data-if-promo]').forEach((el) => { el.hidden = !book.promo; });
  if (book.promo) {
    $$('[data-promo-code]').forEach((el) => { el.textContent = book.promo.code; });
    $$('[data-promo-amount]').forEach((el) => { el.textContent = formatUSD(book.promo.amount_cents); });
  }
}

// ---------- calculator ----------

const calcRooms = $('#calcRooms');
const addonBoxes = $$('[data-addon]');
const fService = $('#fService');

function selection() {
  return { rooms: Number(calcRooms.value), addons: addonBoxes.filter((b) => b.checked).map((b) => b.dataset.addon) };
}

function matchingPackage(sel) {
  const key = (a) => [...a].sort().join(',');
  return book.packages.find((p) => p.rooms === sel.rooms && key(p.addons) === key(sel.addons))?.key ?? null;
}

function updateCalc() {
  const sel = selection();
  $('#roomCount').textContent = sel.rooms === 0 ? 'No rooms' : `${sel.rooms} ${sel.rooms === 1 ? 'room' : 'rooms'}`;
  const q = quote(book, sel);
  const online = quote(book, sel, book.promo);
  $('#calcTotal').textContent = formatUSD(q.total_cents);
  const onlineEl = $('#calcOnline');
  onlineEl.hidden = !online.discount_cents;
  if (online.discount_cents) onlineEl.textContent = `${formatUSD(online.total_cents)} when you book online with ${online.promo_code}`;

  const pkg = matchingPackage(sel);
  $$('[data-package]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.package === pkg)));
  updateFormEstimate();
}

function updateFormEstimate() {
  const box = $('#formEstimateText');
  const service = fService.value;
  if (!ESTIMABLE_SERVICES.includes(service)) {
    box.textContent = `${fService.selectedOptions[0].text} is priced on site. Richard confirms the price before any work starts.`;
    return;
  }
  const sel = selection();
  const q = quote(book, sel);
  if (!q.total_cents) {
    box.textContent = 'Nothing selected yet. Set rooms and add-ons in the estimate above.';
    return;
  }
  const promoCode = $('#fPromo').value.trim().toUpperCase();
  const promo = book.promo && promoCode === book.promo.code ? book.promo : null;
  const p = quote(book, sel, promo);
  box.textContent = `${cap(describeSelection(book, sel))}: ${formatUSD(q.total_cents)}` +
    (p.discount_cents ? `, ${formatUSD(p.total_cents)} with ${p.promo_code}` : '') + ' before tax.';
}

function applySelection(sel) {
  calcRooms.value = sel.rooms;
  addonBoxes.forEach((b) => { b.checked = sel.addons.includes(b.dataset.addon); });
  updateCalc();
}

calcRooms.max = MAX_ROOMS;
[calcRooms, ...addonBoxes].forEach((el) => el.addEventListener('input', updateCalc));

$$('[data-package]').forEach((btn) => btn.addEventListener('click', () => {
  const sel = packageSelection(book, btn.dataset.package);
  if (!sel) return;
  applySelection(sel);
  if (!ESTIMABLE_SERVICES.includes(fService.value)) fService.value = 'carpet';
  updateFormEstimate();
  const form = $('#bookingForm');
  form.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
  form.classList.add('ring-2', 'ring-brand');
  setTimeout(() => form.classList.remove('ring-2', 'ring-brand'), 1200);
}));

fService.addEventListener('change', () => {
  // Pet service always includes the pet treatment add-on.
  if (fService.value === 'pet') {
    const pet = addonBoxes.find((b) => b.dataset.addon === 'addon_pet');
    if (pet && !pet.checked) { pet.checked = true; updateCalc(); }
  }
  updateFormEstimate();
});
$('#fPromo').addEventListener('input', updateFormEstimate);

// ---------- booking form ----------

const form = $('#bookingForm');
const fieldIds = { name: 'fName', phone: 'fPhone', email: 'fEmail', address: 'fAddress', zip: 'fZip', service: 'fService', preferredDate: 'fDate', consent: 'fConsent' };
const today = () => localDate(new Date(), CFG.businessTz);
$('#fDate').min = today();

function utm() {
  const p = new URLSearchParams(location.search);
  const out = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) if (p.get(k)) out[k] = p.get(k).slice(0, 100);
  return Object.keys(out).length ? out : null;
}

function showStatus(kind, text) {
  const el = $('#formStatus');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'mt-4 rounded-xl px-4 py-3 text-sm font-semibold ' +
    (kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200');
}

function clearErrors() {
  showStatus('', '');
  $$('[data-error-for]').forEach((el) => { el.hidden = true; el.textContent = ''; });
  $$('[aria-invalid="true"]', form).forEach((el) => el.removeAttribute('aria-invalid'));
}

function showErrors(errors) {
  const loose = [];
  let first = null;
  for (const [key, msg] of Object.entries(errors)) {
    const slot = $(`[data-error-for="${key}"]`);
    if (!slot) { loose.push(msg); continue; }
    slot.textContent = msg;
    slot.hidden = false;
    const input = fieldIds[key] && $('#' + fieldIds[key]);
    if (input) { input.setAttribute('aria-invalid', 'true'); first ??= input; }
    else first ??= slot;
  }
  if (loose.length) showStatus('error', loose.join(' '));
  (first || $('#formStatus')).scrollIntoView?.({ behavior: scrollBehavior, block: 'center' });
  if (first?.focus) first.focus({ preventScroll: true });
}

let turnstileWidget = null;
if (CFG.turnstileSiteKey && CFG.functionsUrl) {
  window.onTurnstileLoad = () => {
    turnstileWidget = window.turnstile.render('#turnstile', { sitekey: CFG.turnstileSiteKey });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
  s.async = true;
  document.head.appendChild(s);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();
  const val = (id) => $('#' + id).value;
  const sel = selection();
  const body = {
    name: val('fName'), phone: val('fPhone'), email: val('fEmail'), address: val('fAddress'), zip: val('fZip'),
    service: val('fService'), preferredDate: val('fDate'), rooms: sel.rooms, addons: sel.addons,
    package: matchingPackage(sel), notes: val('fNotes'), promo: val('fPromo'),
    consent: $('#fConsent').checked, website: val('fWebsite'), utm: utm(),
  };

  const { errors } = validateQuoteRequest(body, {
    today: today(), maxRooms: MAX_ROOMS, addonKeys: book.addons.map((a) => a.key), packageKeys: book.packages.map((p) => p.key),
  });
  if (Object.keys(errors).length) return showErrors(errors);

  if (!CFG.functionsUrl) {
    return showStatus('error', `Online booking isn't switched on yet. Call or text ${CFG.phoneDisplay} and Richard will book you in.`);
  }
  if (turnstileWidget != null) body.turnstileToken = window.turnstile.getResponse(turnstileWidget);

  const btn = form.querySelector('button[type="submit"]');
  const label = $('#submitText');
  const original = label.textContent;
  label.textContent = 'Sending…';
  btn.disabled = true;
  try {
    const res = await fetch(`${CFG.functionsUrl}/submit-quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      showStatus('ok', json.message);
      showToast(json.message);
      form.reset();
      $('#fPromo').value = book.promo?.code ?? '';
      updateFormEstimate();
    } else {
      showErrors(json.errors || { form: `Something went wrong. Please call ${CFG.phoneDisplay}.` });
    }
  } catch {
    showErrors({ form: `We couldn't reach the booking server. Check your connection, or call ${CFG.phoneDisplay}.` });
  } finally {
    label.textContent = original;
    btn.disabled = false;
    if (turnstileWidget != null) window.turnstile.reset(turnstileWidget);
  }
});

// ---------- toast ----------

const toast = $('#toast');
let toastTimer;
function showToast(text) {
  $('#toastText').textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}
$('#toastClose').addEventListener('click', () => { toast.hidden = true; });

// ---------- navigation, FAQ ----------

const menuBtn = $('#menuBtn');
const mobileMenu = $('#mobileMenu');
menuBtn.addEventListener('click', () => {
  const open = mobileMenu.classList.toggle('hidden') === false;
  menuBtn.setAttribute('aria-expanded', String(open));
});
$$('a', mobileMenu).forEach((a) => a.addEventListener('click', () => {
  mobileMenu.classList.add('hidden');
  menuBtn.setAttribute('aria-expanded', 'false');
}));

const header = $('#header');
addEventListener('scroll', () => header.classList.toggle('shadow-sm', scrollY > 10), { passive: true });

$$('.faqBtn').forEach((btn) => btn.addEventListener('click', () => {
  const wasOpen = btn.getAttribute('aria-expanded') === 'true';
  $$('.faqBtn').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
    b.nextElementSibling.classList.add('hidden');
    b.querySelector('i').className = 'fa-solid fa-plus text-slate-400';
    b.parentElement.classList.remove('border-brand/30');
  });
  if (!wasOpen) {
    btn.setAttribute('aria-expanded', 'true');
    btn.nextElementSibling.classList.remove('hidden');
    btn.querySelector('i').className = 'fa-solid fa-minus text-brand';
    btn.parentElement.classList.add('border-brand/30');
  }
}));

$$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
  const id = a.getAttribute('href');
  const el = id.length > 1 && document.querySelector(id);
  if (el) { e.preventDefault(); el.scrollIntoView({ behavior: scrollBehavior, block: 'start' }); }
}));

// ---------- start ----------

renderPrices();
$('#fPromo').value = book.promo?.code ?? '';
updateCalc();

if (CFG.functionsUrl) {
  fetch(`${CFG.functionsUrl}/price-book`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((live) => {
      book = live;
      renderPrices();
      if (!$('#fPromo').value) $('#fPromo').value = book.promo?.code ?? '';
      updateCalc();
    })
    .catch((err) => console.warn('Using built-in prices; price-book failed:', err));
}
