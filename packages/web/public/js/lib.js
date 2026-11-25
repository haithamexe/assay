/* Shared helpers. Everything that came from git, a page or a test run is untrusted: the only way to put text in the page is the html
   tag below, which escapes every value unless it is already html made by another html tag. Inline styles are blocked by the page's
   policy, so sizes and positions go through data-css and are set with the style object (numbers this code computed, never text). */

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

class Raw { constructor(s) { this.s = s; } }
const part = v => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : esc(v));
export const html = (strings, ...vals) => new Raw(strings.reduce((a, s, i) => a + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const raw = s => new Raw(String(s));

export function applyCss(root) {
  for (const el of root.querySelectorAll('[data-css]')) {
    for (const decl of el.dataset.css.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
  }
}
export function put(el, r) { el.innerHTML = r.s; applyCss(el); }

const I = p => raw(`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`);
export const ico = {
  check: I('<path d="M5 12l5 5 9-10"/>'), x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  alert: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), file: I('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'),
  branch: I('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>'),
  lock: I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  copy: I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>'),
  play: I('<path d="M7 5l12 7-12 7z"/>'), shield: I('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  stop: I('<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>'), search: I('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  eye: I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  users: I('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c3 .2 5 2.3 5 5.8"/>'),
  db: I('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>')
};

/* ---------------------------------------------------------------- talking to the server */
export async function api(path, body) {
  const init = body === undefined
    ? { credentials: 'same-origin', cache: 'no-store' }
    : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON answer */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `The request failed (${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Starts a job and follows it until it ends. `onUpdate` sees every state, so the page can show what it is doing. */
export async function runJob(path, body, onUpdate) {
  let job = await api(path, body);
  if (onUpdate) onUpdate(job);
  while (job.state === 'queued' || job.state === 'running') {
    await sleep(job.state === 'queued' ? 300 : 600);
    job = await api(`/api/job?id=${encodeURIComponent(job.id)}`);
    if (onUpdate) onUpdate(job);
  }
  return job;
}

/* ---------------------------------------------------------------- small things the screens share */
export function announce(text) {
  const l = $('#live');
  if (!l) return;
  l.textContent = '';
  setTimeout(() => { l.textContent = text; }, 30);
}
export function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

/** A button that runs something shows a spinner, then its result on itself, then goes back. No toast. */
export async function morph(btn, run, o = {}) {
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${esc(o.busy || 'Working…')}`;
  let ok = true;
  let out = null;
  try { out = await run(); if (out && out.ok === false) ok = false; } catch { ok = false; }
  if (btn.isConnected) {
    const label = (out && out.label) || (ok ? o.done || 'Done' : 'Failed');
    btn.innerHTML = `${ok ? ico.check.s : ico.x.s}${esc(label)}`;
    btn.classList.add(ok ? 'is-ok' : 'is-bad');
    if (!ok) shake(btn);
    announce(label);
    await sleep(o.hold ?? 1200);
  }
  if (btn.isConnected) { btn.innerHTML = original; btn.disabled = false; btn.classList.remove('is-ok', 'is-bad'); delete btn.dataset.busy; }
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through to the old way */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'visually-hidden';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 45 ? `${d} days ago` : new Date(t).toISOString().slice(0, 10);
}
export const secs = n => (n >= 100 ? `${Math.round(n)} s` : `${Math.round(n * 10) / 10} s`);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many ?? `${one}s`}`;
export const short = h => String(h || '').slice(0, 7);

/* ---------------------------------------------------------------- pieces used on more than one screen */
export const tierLabel = { proven: 'Proven', corroborated: 'Corroborated', hint: 'Hint', fixed: 'Fixed in the range', intended: 'Intended', dismissed: 'Dismissed' };
export const tierBadge = st => html`<span class="badge tier-${st === 'dismissed' ? 'intended' : st}">${st === 'proven' ? ico.check : ''}${tierLabel[st] || st}</span>`;
export const sevBadge = s => (s === 'high' ? html`<span class="badge badge-danger">High</span>` : s === 'medium' ? html`<span class="badge badge-warn">Medium</span>` : html`<span class="badge">Low</span>`);
export const riskBar = r => {
  const t = r >= 75 ? 'danger' : r >= 40 ? 'warn' : 'ok';
  return html`<div class="riskbar" title="Risk score ${r}"><i class="${t}"><b data-css="width:${Math.max(0, Math.min(100, r))}%"></b></i><span>${r}</span></div>`;
};
export const cell = (tone, inner, tip) => html`<span class="cell ${tone}" ${tip ? raw(`title="${esc(tip)}"`) : ''}>${inner}</span>`;
export const loading = (title, sub) => html`<div class="page"><div class="page-head"><div><h1 class="page-title">${title}</h1><p class="page-sub">${sub}</p></div></div><div class="inline-note" role="status"><span class="spinner"></span><span>${sub}</span></div></div>`;
export const problem = (title, message, action) => html`<div class="page"><div class="page-head"><div><h1 class="page-title">${title}</h1></div></div><div class="callout">${ico.alert}<div><b>${message}</b></div>${action || ''}</div></div>`;
