import { afterCase, loadCase, pageCase } from './case.js';
import { loadMemory, pageMemory } from './memory.js';
import { loadReviewers, pageReviewers } from './reviewers.js';
import { loadSettings, pageSettings } from './settings.js';
import { ACT, S, go, navTo, parseHash, restore, setRenderer, setRouter, sync } from './state.js';
import { loadTimeline, pageTimeline } from './timeline.js';
import { $, $$, announce, api, html, ico, put, raw } from './lib.js';

/* The shell: the sidebar, the address, the Jump-to palette, and keeping the page in step with the repository. */

const PAGES = [['timeline', 'Timeline', 'clock'], ['case', 'Case file', 'file'], ['reviewers', 'Reviewers', 'users'], ['memory', 'Memory', 'db'], ['settings', 'Settings', 'gear']];

/* ---------------------------------------------------------------- the sidebar */
function chrome() {
  const { page } = parseHash();
  const blockers = S.view ? S.view.verdict.must.length : 0;
  const link = ([id, label, icon]) => {
    const href = (id === 'case' || id === 'reviewers') && S.caseId ? `#/${id}?id=${encodeURIComponent(S.caseId)}` : `#/${id}`;
    return html`<a href="${href}" ${page === id ? raw('aria-current="page"') : ''}>${ico[icon]}<span>${label}</span>${id === 'case' && blockers ? html`<span class="count" title="Blocking problems">${blockers}</span>` : ''}</a>`;
  };
  put($('#nav'), html`<div class="nav-group">${PAGES.slice(0, 4).map(link)}</div><div class="nav-group nav-settings">${link(PAGES[4])}</div>`);
  put($('#project'), S.repo ? html`<b>${S.repo.name}</b><span class="dim">${S.repo.branch} · ${S.repo.headShort}</span>` : html`<span class="dim">Reading…</span>`);
  const other = S.repo && S.repo.job && !(S.job && S.job.id === S.repo.job.id) ? S.repo.job : null;
  put($('#foot'), html`<div class="live-state" role="status">${S.offline ? html`<span class="dot dot-off"></span> Disconnected: run assay dashboard again` : html`<span class="dot dot-pulse"></span> Live`}</div>${other ? html`<div class="live-state"><span class="spinner"></span> ${other.label}</div>` : ''}${S.repo && !S.repo.allowed ? html`<div class="live-state">${ico.lock} Running this project’s code is off</div>` : ''}`);
}

/* ---------------------------------------------------------------- rendering and routing */
const keyOf = el => (el && el.dataset && el.dataset.act ? [el.dataset.act, el.dataset.h, el.dataset.v, el.dataset.id].join('|') : '');

function render() {
  const { page } = parseHash();
  const focused = keyOf(document.activeElement);
  chrome();
  const fn = { timeline: pageTimeline, case: pageCase, reviewers: pageReviewers, memory: pageMemory, settings: pageSettings }[page] || pageTimeline;
  put($('#main'), fn());
  if (page === 'case') afterCase();
  if (focused) { const el = $$('[data-act]').find(x => keyOf(x) === focused); if (el) el.focus({ preventScroll: true }); }
}

let routeId = 0;
let lastPage = null;
async function route() {
  const mine = ++routeId;
  restore();
  const { page } = parseHash();
  if (!['timeline', 'case', 'reviewers', 'memory', 'settings'].includes(page)) { go('timeline'); return; }
  try {
    if (!S.repo) S.repo = await api('/api/state');
    if (mine !== routeId) return;
    render();
    if (page === 'timeline' && !S.timeline) await loadTimeline();
    if (page === 'case') await loadCase();
    if (page === 'reviewers') await loadReviewers();
    if (page === 'memory') await loadMemory();
    if (page === 'settings') await loadSettings();
    S.error = page === 'case' ? S.error : null;
  } catch (e) {
    S.error = e.message;
  }
  if (mine !== routeId) return;
  sync();
  render();
  if (page !== lastPage) { lastPage = page; const m = $('#main'); if (m) m.scrollTop = 0; }
}
setRenderer(render);
setRouter(route);

document.addEventListener('click', ev => {
  const a = ev.target.closest('a[href^="#/"]');
  if (a && !ev.defaultPrevented && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) { ev.preventDefault(); navTo(a.getAttribute('href')); return; }
  const t = ev.target.closest('[data-act]');
  if (t && !t.disabled) { const fn = ACT[t.dataset.act]; if (fn) fn(t, ev); }
});
window.addEventListener('popstate', () => route());

/* A picture that is gone from disk says so instead of showing a broken icon. */
document.addEventListener('error', ev => {
  const img = ev.target;
  if (img && img.tagName === 'IMG' && img.classList.contains('cmp-img')) {
    const note = document.createElement('p');
    note.className = 'dim missing-shot';
    note.textContent = 'That picture is no longer on disk. Look at the pages again to take it.';
    img.replaceWith(note);
  }
}, true);

/* ---------------------------------------------------------------- staying in step with the repository */
async function poll() {
  if (document.hidden) return;
  try {
    const next = await api('/api/state');
    const moved = S.repo && next.head !== S.repo.head;
    const allowedChanged = S.repo && next.allowed !== S.repo.allowed;
    const wasOffline = S.offline;
    S.offline = false;
    S.repo = { ...S.repo, ...next };
    if (allowedChanged) S.needsOk = null;
    if (moved) {
      S.newCommits = true;
      announce('New commits arrived');
      if (parseHash().page === 'timeline') render(); else chrome();
    } else if (wasOffline || allowedChanged) chrome();
    else if (next.job || (S.repo && S.repo.job)) chrome();
  } catch {
    if (!S.offline) { S.offline = true; chrome(); }
  }
}
setInterval(poll, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------------------------------------------------------------- Jump to (Ctrl K) */
let palSel = 0;
let palItems = [];
function palAll() {
  const items = PAGES.map(([id, l]) => ({ label: `Go to ${l}`, hint: 'page', run: () => go(id, id === 'case' && S.caseId ? { id: S.caseId } : undefined) }));
  for (const r of (S.timeline || []).slice(0, 30)) items.push({ label: `Review ${r.short}: ${r.subject}`, hint: 'commit', run: () => { S.sel.mode = 'single'; S.sel.from = S.sel.to = r.hash; S.caseId = null; S.view = null; S.item = null; go('case'); } });
  if (S.view) {
    items.push({ label: 'Hand the case to the agent', hint: 'action', run: () => { go('case', { id: S.caseId }); setTimeout(() => ACT.brief(), 50); } });
    items.push({ label: 'Run the project’s tests', hint: 'action', run: () => { go('case', { id: S.caseId }); setTimeout(() => ACT.run({ dataset: { v: 'prove' } }), 50); } });
    items.push({ label: 'Look at the pages in a browser', hint: 'action', run: () => { go('case', { id: S.caseId }); setTimeout(() => ACT.run({ dataset: { v: 'look' } }), 50); } });
  }
  items.push({ label: 'Refresh the timeline', hint: 'action', run: () => { go('timeline'); setTimeout(() => ACT.refresh(), 50); } });
  return items;
}
function palDraw() {
  const q = $('#palq').value.toLowerCase();
  palItems = palAll().filter(x => x.label.toLowerCase().includes(q)).slice(0, 9);
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  put($('#pallist'), palItems.length ? html`${palItems.map((x, i) => html`<li><button type="button" data-pi="${i}" aria-selected="${String(i === palSel)}"><span>${x.label}</span><span class="dim right">${x.hint}</span></button></li>`)}` : html`<li class="zero">Nothing matches.</li>`);
}
function palOpen() {
  const d = $('#pal');
  palSel = 0;
  $('#palq').value = '';
  palDraw();
  if (!d.open) d.showModal();
  $('#palq').focus();
}
function palRun() { const x = palItems[palSel]; if (x) { $('#pal').close(); x.run(); } }
ACT.palOpen = palOpen;
document.addEventListener('keydown', ev => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); palOpen(); } });

/* ---------------------------------------------------------------- start */
function boot() {
  const grid = '...xxxxx....|..x.....x...|.x.sss...x..|.xsssss..x..|.x.sss...x..|.x.......x..|..x.....xx..|...xxxxx.xx.|.........xxx|..........xx|............|............'.split('|');
  let rects = '';
  grid.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === 'x') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="var(--accent)"/>`;
    else if (c === 's') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="var(--marker)"/>`;
  }));
  put($('#brand'), html`<svg class="brand-mark" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${raw(rects)}</svg><span class="brand-name">assay</span>`);
  try { const t = localStorage.getItem('assay-theme'); if (t === 'light' || t === 'dark') S.theme = t; } catch { /* the default is the system's */ }
  $('#palq').addEventListener('input', () => { palSel = 0; palDraw(); });
  $('#palq').addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); palDraw(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); palSel = Math.max(0, palSel - 1); palDraw(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); palRun(); }
  });
  $('#pallist').addEventListener('click', ev => { const b = ev.target.closest('[data-pi]'); if (b) { palSel = Number(b.dataset.pi); palRun(); } });
  route();
}
boot();
