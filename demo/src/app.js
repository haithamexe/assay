/* Assay demo. One page of vanilla JS. The real tool would build the DOM with an h() helper and text nodes;
   this prototype uses template strings with escaping, because everything on screen is sample data. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtK = n => (n === 0 ? '0' : (n / 1000).toFixed(1) + 'k');
const I = p => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const ico = {
  check: I('<path d="M5 12l5 5 9-10"/>'), x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  alert: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), file: I('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
  users: I('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.9 0 5 2 5 5.8"/>'),
  db: I('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'),
  branch: I('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>'),
  lock: I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  copy: I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>'),
  play: I('<path d="M7 5l12 7-12 7z"/>'), shield: I('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  stop: I('<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>'), search: I('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>')
};

/* ------------------------------------------------------------------ state */
const PAGES = [['timeline', 'Timeline', 'clock'], ['case', 'Case file', 'file'], ['reviewers', 'Reviewers', 'users'], ['memory', 'Memory', 'db']];
function freshPanel() { return { state: 'idle', plan: null, st: {}, rs: {}, ran: {}, cover: [], tokens: 0, by: { tri: 0, spec: 0, cross: 0, adv: 0 }, gate: null, fixInfo: '' }; }
const S = {
  commits: COMMITS.slice(), mode: 'branch', from: '3c9f118', to: 'a41c9e2', pick: null, fixed: false, budget: 40,
  panel: freshPanel(),
  sel: null, tab: null, lens: 'all', showAll: false, detailMode: 'visual', dismissed: {}, intended: {}, proveRes: {},
  cmp: { vp: 'mobile', theme: 'light', loc: 'ar', mode: 'slider', pos: 50 },
  mem: { sel: 'M-001', q: '', kind: 'all', added: {}, mined: false, adj: {} }, mtab: 'mistakes', rtab: 'panel',
  bis: { sym: 'crash', running: false, log: [], marks: {}, result: null },
  cal: { state: 'idle', n: 0 }, packs: {}, theme: 'auto'
};
const ACT = {};

/* ------------------------------------------------------------------ routing */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, ''); const [p, q = ''] = raw.split('?');
  return { page: p || 'timeline', params: Object.fromEntries(new URLSearchParams(q)) };
}
function restore() {
  const { page, params: p } = parseHash();
  if (page === 'timeline' || page === 'case') {
    if (['single', 'range', 'branch'].includes(p.mode)) S.mode = p.mode;
    if (p.from && S.commits.some(c => c.h === p.from)) S.from = p.from;
    if (p.to && S.commits.some(c => c.h === p.to)) S.to = p.to;
  }
  if (page === 'case') { if (p.item) S.sel = p.item; if (p.tab) S.tab = p.tab; S.lens = p.lens || 'all'; }
  if (page === 'reviewers') S.rtab = p.tab === 'score' ? 'score' : 'panel';
  if (page === 'memory') { if (['standards', 'mine'].includes(p.tab)) S.mtab = p.tab; else S.mtab = 'mistakes'; if (p.id) S.mem.sel = p.id; }
}
function sync() {
  const { page } = parseHash(); let p = {};
  if (page === 'timeline') p = { mode: S.mode, from: S.from, to: S.to };
  else if (page === 'case') p = { mode: S.mode, from: S.from, to: S.to, item: S.sel, tab: S.tab, lens: S.lens === 'all' ? '' : S.lens };
  else if (page === 'reviewers') p = { tab: S.rtab === 'panel' ? '' : S.rtab };
  else if (page === 'memory') p = { tab: S.mtab === 'mistakes' ? '' : S.mtab, id: S.mem.sel };
  const q = new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v))).toString();
  history.replaceState(null, '', '#/' + page + (q ? '?' + q : ''));
}
/* pushState, not location.hash: some previews block fragment navigation, and this works everywhere */
function navTo(h) {
  if (location.hash !== h) { try { history.pushState(null, '', h); } catch { location.hash = h; return; } }
  route();
}
function go(page, extra) { navTo('#/' + page + (extra ? '?' + new URLSearchParams(extra) : '')); }
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[href^="#/"]'); if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  ev.preventDefault(); navTo(a.getAttribute('href'));
});
window.addEventListener('popstate', () => route());
let lastPage = null;
function route() { restore(); sync(); render(); const { page } = parseHash(); if (page !== lastPage) { lastPage = page; $('#main').scrollTop = 0; } }

/* ------------------------------------------------------------------ helpers over the data */
const idxOf = h => S.commits.findIndex(c => c.h === h);
function rangeCommits() {
  if (S.mode === 'branch') return S.commits.slice(0, idxOf(PROJECT.baseline));
  const a = idxOf(S.from), b = idxOf(S.to); const lo = Math.min(a, b), hi = Math.max(a, b);
  return S.commits.slice(lo, hi + 1);
}
const rangeHashes = () => rangeCommits().map(c => c.h);
const itemById = id => ITEMS.find(i => i.id === id);
const memById = id => [...MEMORY, ...MINED].find(m => m.id === id);
function itemVisible(it) { return it.src === 'free' || (S.panel.ran[it.needs] && S.panel.cover.includes(it.commit)); }
function status(it) { if (S.fixed && it.fixable) return 'fixed'; if (S.dismissed[it.id]) return 'dismissed'; if (S.intended[it.id]) return 'intended'; return it.tier; }
const isOpen = it => ['proven', 'corroborated', 'hint'].includes(status(it));
function inRange() { const hs = rangeHashes(); return ITEMS.filter(i => hs.includes(i.commit)); }
const visibleItems = () => inRange().filter(itemVisible).sort((a, b) => b.risk - a.risk);
const hiddenPanel = () => inRange().filter(i => !itemVisible(i));
function verdict() {
  const open = visibleItems().filter(isOpen);
  const must = open.filter(i => i.tier === 'proven' && i.sev === 'high');
  const should = open.filter(i => i.tier === 'proven' && i.sev !== 'high');
  const decide = open.filter(i => i.tier === 'corroborated');
  const hints = open.filter(i => i.tier === 'hint');
  let tone = 'ok', head = 'Clear to merge', icon = ico.shield;
  if (!visibleItems().length) head = 'Nothing significant in this range';
  if (must.length) { tone = 'danger'; head = `Blocked: ${must.length} proven problem${must.length > 1 ? 's' : ''} to fix first`; icon = ico.stop; }
  else if (should.length || decide.length) { tone = 'warn'; head = 'Can merge, with fixes suggested'; icon = ico.alert; }
  return { tone, head, icon, must, should, decide, hints };
}
const rangeTitle = () => S.mode === 'branch' ? 'Checkout redesign' : (S.from === S.to ? (S.commits[idxOf(S.from)]?.m || '') : `${S.from} … ${S.to}`);

/* ------------------------------------------------------------------ the shop's UI under test, rendered live */
function shopHTML(v, o) {
  const L = STR[o.loc]; const dir = o.loc === 'ar' ? 'rtl' : 'ltr';
  const items = L.items.map((it, i) => v === 'after'
    ? `<div class="item"><div class="thumb t${i + 1}"></div><div class="item-title"><div class="name">${e(it.n)}</div><div class="muted small">${e(L.qty)} ${it.q}</div></div><span class="price-badge">${e(it.p)}</span></div>`
    : `<div class="item"><div class="name">${e(it.n)}<div class="muted small">${e(L.qty)} ${it.q}</div></div><span class="price">${e(it.p)}</span></div>`).join('');
  return `<div class="shop" data-v="${v}" data-t="${o.theme}" dir="${dir}" lang="${o.loc}"><h4>${e(L.title)}</h4>${items}
    <div class="row"><span>${e(L.sub)}</span><span>${e(L.subv)}</span></div>
    <div class="row"><span class="muted ship small">${e(L.ship)}</span><span class="muted small">${e(L.shipv)}</span></div>
    <div class="row"><span>${e(L.coupon)}</span><span>${e(L.couponv)}</span></div>
    <div class="row total"><span>${e(L.total)}</span><span>${e(L.totalv)}</span></div>
    <button class="place-order" type="button" tabindex="-1">${e(L.order)}</button></div>`;
}
const parseRGB = s => (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/* Measured, not guessed: boxes overlapping, text wider than its box, colour pairs against their real background. */
function analyze(root) {
  const rr = root.getBoundingClientRect(); const issues = [];
  const rel = r => ({ x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height });
  root.querySelectorAll('.item').forEach(item => {
    const b = item.querySelector('.price-badge'), t = item.querySelector('.thumb'); if (!b || !t) return;
    const br = b.getBoundingClientRect(), tr = t.getBoundingClientRect();
    const ox = Math.min(br.right, tr.right) - Math.max(br.left, tr.left), oy = Math.min(br.bottom, tr.bottom) - Math.max(br.top, tr.top);
    if (ox > 2 && oy > 2) issues.push({ kind: 'overlap', label: 'Price badge covers the product image', detail: `${Math.round(ox)} × ${Math.round(oy)} px overlap`, r: rel(br) });
  });
  const btn = root.querySelector('.place-order');
  if (btn && btn.scrollWidth > btn.clientWidth + 1) issues.push({ kind: 'clip', label: 'The order button’s label is cut off', detail: `label is ${btn.scrollWidth}px in a ${btn.clientWidth}px button`, r: rel(btn.getBoundingClientRect()) });
  const m = root.querySelector('.muted.ship'); let ratio = null;
  if (m) { ratio = contrast(parseRGB(getComputedStyle(m).color), parseRGB(getComputedStyle(root).backgroundColor));
    if (ratio < 4.5) issues.push({ kind: 'contrast', label: `Shipping line is ${ratio.toFixed(1)}:1`, detail: 'needs 4.5:1', r: rel(m.getBoundingClientRect()) }); }
  return { issues, ratio };
}
let MX = null;
function matrix() {
  if (MX) return MX; MX = {};
  for (const vp of ['desktop', 'mobile']) for (const theme of ['light', 'dark']) for (const loc of ['en', 'ar']) {
    const host = document.createElement('div'); host.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;width:${vp === 'mobile' ? 320 : 460}px`;
    host.innerHTML = shopHTML('after', { theme, loc }); document.body.appendChild(host);
    MX[`${vp}|${theme}|${loc}`] = analyze(host.firstElementChild); host.remove();
  }
  return MX;
}
const VPL = { desktop: 'Desktop', mobile: 'Phone' }, LOCL = { en: 'English', ar: 'Arabic' }, THL = { light: 'light', dark: 'dark' };

/* ------------------------------------------------------------------ small builders */
const cell = (tone, html, tip) => `<span class="cell ${tone}" ${tip ? `title="${e(tip)}"` : ''}>${html}</span>`;
const riskBar = r => { const t = r >= 75 ? 'danger' : r >= 40 ? 'warn' : 'ok'; return `<div class="riskbar" title="Risk score ${r}"><i class="${t}"><b style="width:${r}%"></b></i><span>${r}</span></div>`; };
const tierLabel = { proven: 'Proven', corroborated: 'Corroborated', hint: 'Hint', fixed: 'Fixed', intended: 'Intended', dismissed: 'Dismissed' };
const tierBadge = st => `<span class="badge tier-${st === 'dismissed' ? 'intended' : st}">${st === 'proven' ? ico.check : ''}${tierLabel[st]}</span>`;
const sevBadge = s => s === 'high' ? '<span class="badge badge-danger">High</span>' : s === 'medium' ? '<span class="badge badge-warn">Medium</span>' : '<span class="badge">Low</span>';
function diffHTML(d) {
  return `<div class="diff-file"><div class="diff-file-head"><span class="mono">${e(d.file)}</span></div><div class="diff-hunk-head mono">${e(d.head)}</div><div class="diff-grid" tabindex="0" aria-label="Changed lines">${d.rows.map(([t, o, n, x, sig]) =>
    `<div class="diff-row ${t === '-' ? 'del' : t === '+' ? 'add' : ''}${sig ? ' sig' : ''}"><span class="diff-no">${o}</span><span class="diff-no r">${n}</span><span class="diff-mark">${t === ' ' ? '' : t}</span><span class="diff-text">${e(x)}</span></div>`).join('')}</div></div>`;
}
function announce(t) { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 30); }
function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
async function morph(btn, run, o = {}) {
  if (!btn || btn.dataset.busy) return; btn.dataset.busy = '1'; const html = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${e(o.busy || 'Working…')}`;
  let ok = true; try { await run(); } catch (err) { ok = false; }
  if (btn.isConnected) { btn.innerHTML = ok ? `${ico.check}${e(o.done || 'Done')}` : `${ico.x}Failed`; btn.classList.add(ok ? 'is-ok' : 'is-bad'); if (!ok) shake(btn); announce(ok ? (o.done || 'Done') : 'Failed'); await sleep(o.hold || 1200); }
  if (btn.isConnected) { btn.innerHTML = html; btn.disabled = false; btn.classList.remove('is-ok', 'is-bad'); delete btn.dataset.busy; }
}

/* ------------------------------------------------------------------ shell */
function navHTML(page) {
  const blockers = verdict().must.length;
  const link = (id, label, icon, extra = '') => `<a href="#/${id}" ${page === id ? 'aria-current="page"' : ''}>${ico[icon]}<span>${label}</span>${extra}</a>`;
  return `<div class="nav-group">${PAGES.map(([id, l, ic]) => link(id, l, ic, id === 'case' && blockers ? `<span class="count" title="Blocking problems">${blockers}</span>` : '')).join('')}</div>
    <div class="nav-group nav-settings">${link('settings', 'Settings', 'gear')}</div>`;
}
function render() {
  const { page } = parseHash(); const fk = keyOf(document.activeElement);
  $('#nav').innerHTML = navHTML(page);
  const fn = { timeline: pageTimeline, case: pageCase, reviewers: pageReviewers, memory: pageMemory, settings: pageSettings }[page] || pageTimeline;
  $('#main').innerHTML = fn();
  after(page);
  if (fk) { const el = $$('[data-act]').find(x => keyOf(x) === fk); if (el) el.focus({ preventScroll: true }); }
}
const keyOf = el => el && el.dataset && el.dataset.act ? [el.dataset.act, el.dataset.h, el.dataset.v, el.dataset.id, el.dataset.t].join('|') : '';
function after(page) {
  if (page === 'case') drawFlags();
  if (page === 'memory') { const q = $('#memq'); if (q) q.oninput = () => { S.mem.q = q.value; $('#memlist').innerHTML = memListHTML(); }; }
}
document.addEventListener('click', ev => { const t = ev.target.closest('[data-act]'); if (!t || t.disabled) return; ACT[t.dataset.act]?.(t, ev); });
document.addEventListener('change', ev => { const t = ev.target.closest('[data-chg]'); if (t) ACT[t.dataset.chg]?.(t, ev); });

/* ------------------------------------------------------------------ timeline */
function pageTimeline() {
  const rng = rangeCommits(); const cs = S.commits; const asc = [...cs].reverse();
  const hint = S.mode === 'branch' ? 'The whole branch is selected.' : S.mode === 'single' ? 'Click a commit.' : S.pick ? 'Now click the other end of the range.' : 'Click a commit, then another.';
  const rows = cs.map(c => {
    const inR = rng.includes(c); const mD = c.mut[0] - c.mut[1]; const bm = S.bis.marks[c.h];
    return `<tr class="crow ${inR ? 'in-range' : ''} ${c.base ? 'is-base' : ''} ${bm ? 'bis-' + bm : ''}">
      <td class="lane" aria-hidden="true"><span class="lane-dot ${c.fix ? 'fix' : ''}"></span></td>
      <td><button class="commit-btn" data-act="pick" data-h="${c.h}" aria-pressed="${inR}" ${S.mode === 'branch' ? 'disabled' : ''}><span class="mono hash">${c.h}</span><span class="c-msg">${e(c.m)}</span><span class="dim c-meta">${e(c.by)} · ${e(c.when)} · ${e(c.langs)}${c.base ? ' · baseline' : ''}</span></button></td>
      <td>${cell('ok', ico.check + ' pass', 'The project built')}</td>
      <td>${c.tests[0] === c.tests[1] ? cell('ok', `${c.tests[0]}/${c.tests[1]}`, 'All tests passed') : cell('danger', `${c.tests[0]}/${c.tests[1]}`, 'Tests failed')}</td>
      <td>${mD < 0 ? cell(mD <= -10 ? 'warn' : '', `${c.mut[0]}% ▼${-mD}`, 'Share of deliberate changes the tests caught, on the changed lines') : cell('', `${c.mut[0]}%`, 'Share of deliberate changes the tests caught')}</td>
      <td>${c.look ? cell(c.look > 3 ? 'warn' : '', c.look + '%', 'Share of pixels that changed on the pages checked') : cell('none', '—')}</td>
      <td>${c.calls ? cell('danger', `${c.calls} changed`, 'Calls that answer differently from the baseline') : cell('none', '—')}</td>
      <td>${c.a11y ? cell('warn', '+' + c.a11y, 'New accessibility problems') : cell('none', '—')}</td>
      <td>${c.safe ? cell('danger', `${c.safe} proven`, 'Security problems a probe proved') : cell('none', '—')}</td>
      <td>${riskBar(c.risk)}</td></tr>`;
  }).join('');
  const strip = asc.map(c => { const inR = rng.includes(c); const t = c.risk >= 75 ? 'danger' : c.risk >= 40 ? 'warn' : 'ok';
    return `<button data-act="pick" data-h="${c.h}" aria-pressed="${inR}" aria-label="${c.h}, risk ${c.risk}" title="${c.h} · risk ${c.risk}"><span class="bar ${t}" style="height:${Math.max(6, c.risk * 0.7)}px"></span></button>`; }).join('');
  const sym = SYMPTOMS.find(s => s.id === S.bis.sym);
  return `<div class="page">
    <div class="page-head"><div><h1 class="page-title">Timeline</h1><p class="page-sub">${e(PROJECT.name)} · ${e(PROJECT.branch)}. The free checks ran on every commit and are kept by hash, so picking again is instant.</p></div>
      <div class="toolbar"><div class="segmented" role="group" aria-label="What to review">
        ${[['single', 'One commit'], ['range', 'Range'], ['branch', 'Whole branch']].map(([v, l]) => `<button data-act="mode" data-v="${v}" aria-pressed="${S.mode === v}">${l}</button>`).join('')}</div>
        <button class="btn btn-primary" data-act="openCase">Open case file ${ico.file}</button></div></div>
    <div class="inline-note">${ico.branch}<span><b>${rng.length}</b> commit${rng.length > 1 ? 's' : ''} · ${rng[rng.length - 1].h} → ${rng[0].h} · compared with ${PROJECT.baseline} · ${e(hint)}</span></div>
    <div class="card"><div class="riskstrip" role="group" aria-label="Risk by commit, oldest to newest">${strip}</div><div class="riskaxis">${asc.map(c => `<span>${c.h}</span>`).join('')}</div>
      <div class="table-wrap"><table class="table tl"><thead><tr><th></th><th>Commit</th><th title="The project builds">Build</th><th title="Tests passed">Tests</th><th title="Mutation score on the changed lines">Mutants</th><th title="Share of pixels that changed">Look</th><th title="Calls that answer differently">Calls</th><th title="New accessibility problems">A11y</th><th title="Proven security problems">Safety</th><th>Risk</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="card"><div class="card-head"><span class="card-title">Find where it broke</span><span class="dim">Runs the same free checks across the commits, halving the range each time.</span></div>
      <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
        <div class="toolbar"><label class="visually-hidden" for="sym">Symptom</label><select id="sym" data-chg="sym">${SYMPTOMS.map(s => `<option value="${s.id}" ${s.id === S.bis.sym ? 'selected' : ''}>${e(s.label)}</option>`).join('')}</select>
          <button class="btn" data-act="bisect" ${S.bis.running ? 'disabled' : ''}>${ico.search} Bisect</button></div>
        ${S.bis.log.length ? `<ul class="bisect-log" aria-live="polite">${S.bis.log.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}
        ${S.bis.result ? `<div class="callout">${ico.alert}<div><b>First broken commit: <span class="mono">${S.bis.result}</span></b><br><span class="dim">${e(S.commits.find(c => c.h === S.bis.result).m)}</span></div><button class="btn btn-sm right" data-act="openCommit" data-h="${S.bis.result}">Open that commit</button></div>` : ''}
      </div></div></div>`;
}
ACT.pick = el => {
  const h = el.dataset.h;
  if (S.mode === 'branch') S.mode = 'single';
  if (S.mode === 'single') { S.from = S.to = h; S.pick = null; }
  else if (!S.pick) { S.pick = h; S.from = S.to = h; } else { S.from = S.pick; S.to = h; S.pick = null; }
  S.sel = null; sync(); render();
};
ACT.mode = el => {
  const m = el.dataset.v; const bi = idxOf(PROJECT.baseline);
  if (m === 'branch') { S.from = S.commits[bi - 1].h; S.to = S.commits[0].h; }
  else if (m === 'single') { S.from = S.to = S.to; }
  else if (S.mode === 'branch') { S.from = S.commits[bi - 1].h; S.to = S.commits[0].h; }
  S.mode = m; S.pick = null; S.sel = null; sync(); render();
};
ACT.openCase = () => { S.sel = null; go('case'); };
ACT.openCommit = el => { S.mode = 'single'; S.from = S.to = el.dataset.h; S.sel = null; go('case'); };
ACT.sym = el => { S.bis = { ...S.bis, sym: el.value, log: [], marks: {}, result: null }; render(); };
ACT.bisect = async () => {
  const sym = SYMPTOMS.find(s => s.id === S.bis.sym); const ord = [...S.commits].filter(c => !c.fix).reverse();
  const badIdx = ord.findIndex(c => c.h === sym.firstBad); let lo = 0, hi = ord.length - 1;
  S.bis = { ...S.bis, running: true, log: [`Known good: <b>${ord[lo].h}</b> · known broken: <b>${ord[hi].h}</b>`], marks: { [ord[lo].h]: 'ok', [ord[hi].h]: 'bad' }, result: null }; render();
  let n = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2); await sleep(700); n++;
    const bad = mid >= badIdx; S.bis.marks[ord[mid].h] = bad ? 'bad' : 'ok';
    S.bis.log.push(`Step ${n}: ran the checks on <b>${ord[mid].h}</b> → ${bad ? '<span style="color:var(--danger)">broken</span>' : '<span style="color:var(--ok)">fine</span>'} (${hi - lo - 1} commit${hi - lo - 1 > 1 ? 's' : ''} left to look at)`);
    if (bad) hi = mid; else lo = mid; render();
  }
  await sleep(400); S.bis.running = false; S.bis.result = ord[hi].h; S.bis.log.push(`Done in ${n} steps instead of ${ord.length - 2}. Each check reused the saved results where it could.`); render(); announce('Found the first broken commit ' + ord[hi].h);
};

/* ------------------------------------------------------------------ case file */
function pageCase() {
  const vis = visibleItems(); const v = verdict(); const rng = rangeCommits();
  if (!vis.find(i => i.id === S.sel)) S.sel = vis.find(isOpen)?.id || vis[0]?.id || null;
  const lenses = [...new Set(vis.map(i => i.lens))];
  if (S.lens !== 'all' && !lenses.includes(S.lens)) S.lens = 'all';
  const shown = vis.filter(i => S.lens === 'all' || i.lens === S.lens);
  const open = shown.filter(isOpen), done = shown.filter(i => !isOpen(i));
  const ordered = [...open, ...done]; const folded = !S.showAll && ordered.length > 5; const list = folded ? ordered.slice(0, 5) : ordered;
  const files = rng.reduce((a, c) => a + c.files, 0); const langs = [...new Set(rng.flatMap(c => c.langs.split(' · ')))].filter(x => x !== 'images');
  const secs = rng.reduce((a, c) => a + c.secs, 0); const hid = hiddenPanel(); const plan = makePlan();
  const panelLine = S.panel.state === 'done' && rng.every(c => S.panel.cover.includes(c.h)) ? `Reviewers: <b>${fmtK(S.panel.tokens)} tokens</b>` : S.panel.state === 'running' ? 'Reviewers: <b>running…</b>' : `Reviewers: <b>not run</b> (about ${fmtK(plan.total)} tokens at the ${S.budget}k budget)`;
  const it = itemById(S.sel);
  const head = `<div class="page-head"><div><h1 class="page-title">${e(rangeTitle())}</h1><p class="page-sub">${S.mode === 'branch' ? e(PROJECT.branch) + ' · ' : ''}${rng.length} commit${rng.length > 1 ? 's' : ''} · ${files} files · ${langs.map(e).join(', ')}</p></div>
    <div class="toolbar"><a class="btn" href="#/timeline">${ico.clock} Change the commits</a></div></div>`;
  const verdictCard = `<section class="verdict ${v.tone}" aria-label="Verdict"><div class="verdict-icon">${v.icon}</div>
    <div><h2>${e(v.head)}</h2><p class="counts"><b>${v.must.length}</b> must fix · <b>${v.should.length}</b> should fix · <b>${v.decide.length}</b> to decide · <b>${v.hints.length}</b> hint${v.hints.length === 1 ? '' : 's'}${hid.length ? ` · <b>${hid.length}</b> more need the reviewers` : ''}</p></div>
    <div class="toolbar">${v.must.length || v.should.length ? `<button class="btn btn-primary" data-act="brief">${ico.copy} Hand to the agent</button>` : ''}
      ${S.panel.state === 'running' ? `<button class="btn btn-second" disabled><span class="spinner"></span> Reviewers running</button>` : `<button class="btn btn-second" data-act="runPanel" ${S.budget === 0 ? 'disabled title="Budget is set to free only"' : ''}>${ico.users} ${S.panel.state === 'done' ? 'Re-run reviewers' : 'Run reviewers'}</button>`}
      ${v.must.length && !S.fixed ? `<button class="btn btn-ghost" data-act="simfix">${ico.play} Simulate the agent’s fix</button>` : ''}</div>
    <div class="verdict-foot"><span>Free checks: <b>${secs} s, 0 tokens</b></span><span>${panelLine}</span>${S.fixed ? `<span>${ico.check} Fixed in <b class="mono">${FIX_COMMIT.h}</b>${S.panel.fixInfo ? ' · ' + e(S.panel.fixInfo) : ''}</span>` : ''}</div></section>`;
  const facets = lenses.length > 1 ? `<div class="facets" role="group" aria-label="Filter by lens"><button class="btn btn-sm ${S.lens === 'all' ? '' : 'btn-ghost'}" data-act="lens" data-v="all" aria-pressed="${S.lens === 'all'}">All <span class="n">${vis.length}</span></button>${lenses.map(l => `<button class="btn btn-sm ${S.lens === l ? '' : 'btn-ghost'}" data-act="lens" data-v="${e(l)}" aria-pressed="${S.lens === l}">${e(l)} <span class="n">${vis.filter(i => i.lens === l).length}</span></button>`).join('')}</div>` : '';
  const listHTML = list.map((i, k) => { const st = status(i); return `<button class="citem ${isOpen(i) ? '' : 'is-done'}" data-act="sel" data-id="${i.id}" aria-pressed="${i.id === S.sel}"><span class="rank">${k + 1}</span><span><span class="it-title">${e(i.title)}</span><span class="it-meta">${tierBadge(st)} <span class="chip-lang">${i.lang}</span><span class="mono">${e(i.file.split('/').pop())}</span><span>risk ${i.risk}</span></span></span></button>`; }).join('');
  const pending = hid.length ? `<div class="pending-note">${ico.users} ${hid.length} more check${hid.length > 1 ? 's' : ''} need the reviewers (${hid.map(h => e(h.lens.toLowerCase())).join(', ')}). The free checks above already ran.</div>` : '';
  const body = vis.length ? `<div class="split"><div class="itemlist" role="list" aria-label="Significant changes, most important first">${listHTML}${folded ? `<button class="btn btn-ghost" data-act="showAll">Show all ${ordered.length}</button>` : ''}${pending}</div>${it ? detailHTML(it) : ''}</div>` : `<div class="card zero">Nothing significant in this range. The free checks found no change in behaviour, looks or safety. ${pending}</div>`;
  return `<div class="page page-wide">${head}${verdictCard}${facets}${body}</div>`;
}
ACT.lens = el => { S.lens = el.dataset.v; sync(); render(); };
ACT.showAll = () => { S.showAll = true; render(); };
ACT.sel = el => { S.sel = el.dataset.id; S.tab = null; const it = itemById(S.sel); if (it.ui) S.cmp = { ...S.cmp, ...it.combo }; sync(); render(); };

function dynObserved(it) {
  if (it.id === 'rtl') {
    const m = matrix(); const fails = Object.entries(m).filter(([, r]) => r.issues.some(x => it.kinds.includes(x.kind))); const allAr = fails.every(([k]) => k.endsWith('|ar'));
    return [`Measured in 8 combinations of size, theme and language. Problems showed in <b>${fails.length}</b> of 8${fails.length && allAr ? ', all of them Arabic' : ''}.`, 'The price badge sits on top of the product image, and the order button’s label is wider than its box.'];
  }
  if (it.id === 'contrast') {
    const m = matrix(); const d = m['mobile|dark|en'].ratio, l = m['mobile|light|en'].ratio;
    return [`The “Free shipping” line measures <b>${d.toFixed(1)}:1</b> in the dark theme. The minimum is 4.5:1. In the light theme it measures ${l.toFixed(1)}:1.`];
  }
  return it.observed;
}
function detailHTML(it) {
  const st = status(it); const tabs = [...(it.ui ? [['ba', 'Before / after']] : []), ['code', 'Code'], ['out', 'Output'], ['ev', 'Evidence']];
  const tab = tabs.some(t => t[0] === S.tab) ? S.tab : tabs[0][0];
  const mems = it.memory.map(memById).filter(Boolean);
  const ran = Object.keys(S.panel.ran).filter(k => S.panel.ran[k]); const ranNames = REVIEWERS.filter(r => S.panel.ran[r.id]).map(r => r.name);
  const rev = S.panel.state === 'done' && S.panel.cover.includes(it.commit)
    ? `<div class="revstrip"><span class="badge badge-ai">${ico.users} Reviewers</span>${ranNames.map(n => it.flaggedBy.includes(n) ? `<span class="badge badge-ai">${e(n)}: flagged</span>` : `<span class="silent">${e(n)}: silent</span>`).join(' ')}${S.panel.ran.tri && it.flaggedBy.includes('Triage') ? '<span class="badge badge-ai">Triage: flagged</span>' : ''}</div>`
    : `<div class="revstrip"><span class="badge">${ico.check} Free checks only</span><span>No model has looked at this yet.</span></div>`;
  const intent = it.intent && it.intent.text ? `<p><span class="tag" style="background:var(--second-soft);color:var(--second-ink)">Intent</span><span>${e(it.intent.text)} ${it.intent.verdict === 'unintended' ? '<b>Looks unintended.</b>' : it.intent.verdict === 'unknown' ? '<b>Needs a yes or no.</b>' : ''}</span></p>` : '';
  const sline = st === 'dismissed' ? `<span class="inline-note">${ico.check} Dismissed as a false positive. ${mems.length ? e(mems[0].id) + ' now counts one more dismissal.' : ''}</span><button class="btn btn-sm btn-ghost" data-act="undo" data-id="${it.id}">Undo</button>`
    : st === 'intended' ? `<span class="inline-note">${ico.check} Marked as intended. It no longer counts against the verdict.</span><button class="btn btn-sm btn-ghost" data-act="undo" data-id="${it.id}">Undo</button>`
    : st === 'fixed' ? `<span class="inline-note">${ico.check} Fixed in <span class="mono">${FIX_COMMIT.h}</span>. The same check passed on that commit.</span>`
    : `${it.intent && it.intent.verdict === 'unknown' ? `<button class="btn btn-sm" data-act="intended" data-id="${it.id}">Mark as intended</button>` : ''}${it.provable ? `<button class="btn btn-sm" data-act="prove" data-id="${it.id}" ${S.proveRes[it.id] ? 'disabled' : ''}>${S.proveRes[it.id] ? 'Tried: no evidence' : 'Try to prove it'}</button>` : ''}<button class="btn btn-sm btn-ghost" data-act="dismiss" data-id="${it.id}">Dismiss as a false positive</button>`;
  const proveNote = S.proveRes[it.id] && st === 'hint' ? `<div class="callout">${ico.search}<div><b>Couldn’t make it fail.</b> 40 generated carts, no total off by a cent. It stays a hint and can’t block a merge.</div></div>` : '';
  return `<article class="card" aria-label="${e(it.title)}"><div class="detail-head"><div class="badges">${tierBadge(st)}${sevBadge(it.sev)}<span class="chip-lang">${it.lang}</span><span class="mono dim">${e(it.file)}:${it.lines}</span><span class="badge">${e(it.ref)}</span><span class="badge">in ${it.commit}</span></div>
      <h3>${e(it.title)}</h3>
      <div class="meaning"><p><span class="tag tag-observed">Observed</span><span>${dynObserved(it).join('</span></p><p><span class="tag tag-observed">Observed</span><span>')}</span></p>
        ${it.inferred.map(t => `<p><span class="tag tag-inferred">Inferred</span><span>${t}</span></p>`).join('')}${intent}</div>
      <div class="why"><span>Ranks here because:</span>${it.why.map(w => `<span class="badge">${w}</span>`).join('')}</div>${rev}${proveNote}</div>
    <div class="detail-tabs"><div class="segmented" role="group" aria-label="Detail">${tabs.map(([k, l]) => `<button data-act="tab" data-v="${k}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div></div>
    <div class="tabbody">${tab === 'ba' ? tabUI(it) : tab === 'code' ? tabCode(it, mems) : tab === 'out' ? tabOut(it) : tabEv(it)}</div>
    <div class="detail-actions">${sline}</div></article>`;
}
ACT.tab = el => { S.tab = el.dataset.v; sync(); render(); };
ACT.dismiss = el => { const it = itemById(el.dataset.id); S.dismissed[it.id] = true; it.memory.forEach(m => { const a = S.mem.adj[m] || { hits: 0, fp: 0 }; a.hits++; a.fp++; S.mem.adj[m] = a; }); render(); announce('Dismissed'); };
ACT.intended = el => { S.intended[el.dataset.id] = true; render(); announce('Marked as intended'); };
ACT.undo = el => { const it = itemById(el.dataset.id); if (S.dismissed[it.id]) { delete S.dismissed[it.id]; it.memory.forEach(m => { const a = S.mem.adj[m]; if (a) { a.hits--; a.fp--; } }); } delete S.intended[it.id]; render(); };
ACT.prove = async el => { const id = el.dataset.id; await morph(el, () => sleep(1800), { busy: 'Writing 40 cases…', done: 'Ran 40 cases', hold: 600 }); S.proveRes[id] = 'none'; render(); };

function tabCode(it, mems) {
  const memHTML = mems.map(m => { const a = S.mem.adj[m.id] || { hits: 0, fp: 0 }; return `<div class="callout">${ico.db}<div><b><a href="#/memory?id=${m.id}">${m.id}</a> ${e(m.name)}</b><br><span class="dim">${e(m.from)} Seen ${m.hits + a.hits} times, ${m.fp + a.fp} dismissed. Detector: ${e(m.det)}.</span></div></div>`; }).join('');
  return `${diffHTML(it.diff)}<div class="legend"><span><i></i>Marked lines are why this ranked high</span><span>${it.diff.rows.filter(r => r[0] === '+').length} added · ${it.diff.rows.filter(r => r[0] === '-').length} removed</span></div>${memHTML}`;
}
function tabEv(it) {
  return `<div class="evlist">${it.evidence.map(ev => `<div class="ev"><div><div class="badges"><span class="badge badge-accent">${e(ev.kind)}</span><span class="dim">${e(ev.who)}</span></div><p class="ev-what">${e(ev.what)}</p><p class="ev-cmd"><code>${e(ev.cmd)}</code></p></div><button class="btn btn-sm" data-act="repro" data-id="${ev.id}">${ico.play} Reproduce</button></div>`).join('')}</div><p class="dim">Every proven finding carries evidence you can run again. A claim with none is shown as a hint, or dropped.</p>`;
}
ACT.repro = el => morph(el, () => sleep(900), { busy: 'Replaying…', done: 'Reproduced' });

/* output tab: visual first, raw one click away (the design rule) */
function kv(rows, h = ['', 'Before', 'After']) {
  return `<div class="kv"><div class="h">${h[0]}</div><div class="h">${h[1]}</div><div class="h">${h[2]}</div>${rows.map(([k, a, b, tone]) => `<div class="rowl">${k}</div><div>${a}</div><div class="${tone || ''}">${b}</div>`).join('')}</div>`;
}
function tabOut(it) {
  const raw = S.detailMode === 'raw';
  const seg = `<div class="segmented" role="group" aria-label="Show"><button data-act="dmode" data-v="visual" aria-pressed="${!raw}">Visual</button><button data-act="dmode" data-v="raw" aria-pressed="${raw}">Raw</button></div>`;
  const o = OUT[it.out](it); return `${seg}${raw ? `<pre class="rawblock" tabindex="0">${o.raw}</pre>` : o.visual}`;
}
ACT.dmode = el => { S.detailMode = el.dataset.v; render(); };
const OUT = {
  probe: () => ({ visual: kv([['Typed in the box', '<code>"&gt;&lt;assay-probe data-xss&gt;</code>', 'the same'], ['In the page', 'A text node, escaped', 'A real <code>&lt;assay-probe&gt;</code> element', 'bad'], ['Found by', '—', 'headless Chrome, 1 of 1 tries'], ['Page', '/cart', '/cart']]),
    raw: `<span class="dimc">POST /api/cart/coupon</span>\n{ "code": "\\"&gt;&lt;assay-probe data-xss&gt;&lt;/assay-probe&gt;" }\n\n<span class="dimc">answer → inserted with dangerouslySetInnerHTML</span>\n&lt;p class="coupon-error"&gt;Coupon "&gt;<span class="bad">&lt;assay-probe data-xss&gt;&lt;/assay-probe&gt;</span> is not valid&lt;/p&gt;` }),
  crash: () => ({ visual: kv([['Request', '<code>POST /api/cart/coupon</code> (empty cart)', 'the same'], ['Status', '400', '500', 'bad'], ['Body', '<code>{"error":"cart is empty"}</code>', '<code>{"error":"internal"}</code>', 'bad'], ['Time', '12 ms', '31 ms'], ['Server log', '—', '<code>IndexError: list index out of range (api/cart.py:83)</code>', 'bad'], ['Pages that call it', 'Cart, Checkout', 'Cart, Checkout (2 pages affected)']], ['', '5c1e0aa', '9d03b7f']),
    raw: `<span class="dimc">5c1e0aa</span>\nHTTP 400  { "error": "cart is empty" }  12 ms\n\n<span class="dimc">9d03b7f</span>\n<span class="bad">HTTP 500</span>  { "error": "internal" }  31 ms\nTraceback (most recent call last):\n  File "api/cart.py", line 83, in apply_coupon\n<span class="bad">IndexError: list index out of range</span>` }),
  rtl: it => { const m = matrix(); const rows = Object.entries(m).map(([k, r]) => { const [vp, th, lo] = k.split('|'); const n = r.issues.filter(x => it.kinds.includes(x.kind)); return `<div class="k">${LOCL[lo]} · ${THL[th]} · ${VPL[vp]}</div><div>${n.length ? `<span class="badge badge-danger">${n.map(x => x.kind).join(' + ')}</span>` : '<span class="badge badge-ok">clean</span>'}</div>`; }).join('');
    return { visual: `<div class="facts">${rows}</div>`, raw: e(JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r.issues.filter(x => it.kinds.includes(x.kind)).map(x => ({ kind: x.kind, detail: x.detail }))])), null, 1)) }; },
  contrast: () => { const m = matrix(); const rows = [['desktop|light|en', 'Light theme'], ['desktop|dark|en', 'Dark theme']].map(([k, l]) => { const r = m[k].ratio; return `<div class="k">${l}: “Free shipping” on its background</div><div>${r >= 4.5 ? `<span class="badge badge-ok">${r.toFixed(1)}:1</span>` : `<span class="badge badge-danger">${r.toFixed(1)}:1 · needs 4.5:1</span>`}</div>`; }).join('');
    return { visual: `<div class="facts">${rows}</div>`, raw: `dark  fg #6e6895  on  bg #181529  →  ${m['desktop|dark|en'].ratio.toFixed(2)}:1\nlight fg #6a6784  on  bg #ffffff  →  ${m['desktop|light|en'].ratio.toFixed(2)}:1\nrule  WCAG 1.4.3 Contrast (Minimum): 4.5:1 for normal text` }; },
  mut: () => ({ visual: `<div class="mutbar" role="img" aria-label="14 killed, 9 survived"><i class="killed" style="width:61%"></i><i class="alive" style="width:39%"></i></div><div class="legend"><span>14 killed (the tests noticed)</span><span style="color:var(--danger)">9 survived (they didn’t)</span></div>
      <div class="facts">${[['<code>rule.value / 100</code> → <code>rule.value * 100</code>', 'api/discount.py:14'], ['<code>total - …</code> → <code>total + …</code>', 'api/discount.py:14'], ['<code>max(…, 0)</code> → <code>min(…, 0)</code>', 'api/discount.py:15'], ['<code>== "percent"</code> → <code>!= "percent"</code>', 'api/discount.py:13']].map(([a, b]) => `<div>${a}</div><div class="mono dim">${b}</div>`).join('')}</div><p class="dim">4 of the 9 surviving changes shown.</p>`,
    raw: `mutants run   23\nkilled        14\nsurvived       9   <span class="bad">← tests still passed</span>\nscore         61%  (baseline 74%)\n\n- return total - total * rule.value / 100\n+ return total - total * rule.value <span class="bad">*</span> 100      <span class="bad">SURVIVED</span>` }),
  dep: () => ({ visual: `<div class="facts">${[['Age of the package', '3 days'], ['Maintainers', '1'], ['Downloads last week', '41'], ['Install script', 'postinstall: makes a network request'], ['Name distance to a package you use', '1 letter from <code>coupon-util</code>']].map(([a, b]) => `<div class="k">${a}</div><div><b>${b}</b></div>`).join('')}</div><p class="dim">Four signals from four sources. None proves a look-alike; together they’re enough to ask.</p>`,
    raw: `{\n  "name": "coupon-utils", "version": "0.3.1",\n  "published": "3 days ago", "maintainers": 1, "weeklyDownloads": 41,\n  "scripts": { "postinstall": "node fetch.js" },\n  "nearestKnown": { "name": "coupon-util", "editDistance": 1 }\n}` }),
  scope: () => ({ visual: `<p class="dim">The request names two things: <b>the order summary</b> and <b>server-side coupons</b>.</p><div class="facts">${[['web/src/checkout/summary.css', '✓ order summary'], ['api/cart.py', '✓ coupons'], ['api/discount.py', '✓ coupons'], ['package.json', '✓ coupons (a new dependency)'], ['web/src/analytics/track.ts', '<span style="color:var(--danger)">✗ matches neither</span>']].map(([a, b]) => `<div class="mono">${a}</div><div>${b}</div>`).join('')}</div>`,
    raw: `request: "${PROJECT.request}"\nthings named: [order summary, coupons on the server]\nfiles traced: 14 of 15\nuntraced: web/src/analytics/track.ts` }),
  round: it => ({ visual: `<div class="facts"><div class="k">The claim</div><div>Float arithmetic on money may drift by a cent.</div><div class="k">Evidence</div><div>${S.proveRes[it.id] ? '40 generated carts, none off' : 'none yet'}</div><div class="k">Allowed to block a merge</div><div><b>No</b> (a hint)</div></div>`,
    raw: `claim   total = total * 0.9   (float)\nproof   ${S.proveRes[it.id] ? '40 generated carts, max error 0.00' : 'none'}\nstatus  hint` })
};

/* before / after: live components, measured */
function tabUI(it) {
  const c = S.cmp; const m = matrix(); const cur = m[`${c.vp}|${c.theme}|${c.loc}`];
  const seg = (key, opts) => `<div class="segmented" role="group" aria-label="${key}">${opts.map(([v, l]) => `<button data-act="cmpset" data-t="${key}" data-v="${v}" aria-pressed="${c[key] === v}">${l}</button>`).join('')}</div>`;
  const cells = ['en', 'ar'].flatMap(lo => ['light', 'dark'].flatMap(th => ['desktop', 'mobile'].map(vp => {
    const n = m[`${vp}|${th}|${lo}`].issues.filter(x => it.kinds.includes(x.kind)).length; const on = c.vp === vp && c.theme === th && c.loc === lo;
    return `<button class="mcell" data-act="combo" data-id="${vp}|${th}|${lo}" aria-pressed="${on}"><span class="st ${n ? 'bad' : 'ok'}">${n ? ico.x + n + ' problem' + (n > 1 ? 's' : '') : ico.check + 'clean'}</span><span class="dim">${LOCL[lo]} · ${THL[th]} · ${VPL[vp]}</span></button>`; })));
  const inner = `stage-inner ${c.vp === 'mobile' ? 'mobile' : ''}`;
  const before = shopHTML('before', c), afterH = shopHTML('after', c);
  const stage = c.mode === 'side'
    ? `<div class="stage"><div class="${inner}" style="width:100%;max-width:${c.vp === 'mobile' ? 700 : 940}px"><div class="cmp-side"><figure><figcaption>Before · ${PROJECT.baseline}</figcaption><div class="flagbox" inert>${before}</div></figure><figure><figcaption>After · ${it.commit}</figcaption><div class="flagbox"><div inert>${afterH}</div><div class="flags"></div></div></figure></div></div></div>`
    : `<div class="stage"><div class="${inner}"><div class="cmp-stack flagbox" data-mode="${c.mode}" style="--pos:${c.pos}%"><div class="layer after" inert>${afterH}</div><div class="layer before" inert>${before}</div><div class="flags"></div><button class="handle" role="slider" aria-label="Compare before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.pos}"></button></div></div></div>`;
  return `<div class="cmp-bar">${seg('mode', [['slider', 'Slider'], ['side', 'Side by side'], ['diff', 'Difference']])}${seg('vp', [['desktop', 'Desktop'], ['mobile', 'Phone']])}${seg('theme', [['light', 'Light'], ['dark', 'Dark']])}${seg('loc', [['en', 'English · LTR'], ['ar', 'العربية · RTL']])}</div>
    <div class="cmp-matrix" role="group" aria-label="All eight combinations, measured">${cells.join('')}</div>${stage}
    <div class="legend"><span>${c.mode === 'diff' ? 'Black means unchanged.' : 'Drag the handle, or use the arrow keys.'}</span><span>Red boxes are measured on the page, not drawn by hand.</span></div>
    <ul class="issues" id="issues" aria-live="polite"></ul>`;
}
ACT.cmpset = el => { S.cmp[el.dataset.t] = el.dataset.v; render(); };
ACT.combo = el => { const [vp, theme, loc] = el.dataset.id.split('|'); S.cmp = { ...S.cmp, vp, theme, loc }; render(); };
function drawFlags() {
  const it = itemById(S.sel); if (!it || !it.ui || S.tab && S.tab !== 'ba') return; const afterEl = $('.stage .shop[data-v="after"]'); if (!afterEl) return;
  const box = afterEl.closest('.flagbox'); const flags = $('.flags', box); const res = analyze(afterEl); const mine = res.issues.filter(i => it.kinds.includes(i.kind));
  flags.innerHTML = mine.map(i => `<div class="flag" style="left:${i.r.x}px;top:${i.r.y}px;width:${i.r.w}px;height:${i.r.h}px"><em>${e(i.label)}</em></div>`).join('');
  $('#issues').innerHTML = mine.length ? mine.map(i => `<li>${ico.x}<span><b>${e(i.label)}</b> <span class="dim">· ${e(i.detail)}</span></span></li>`).join('') : `<li>${ico.check}<span>Nothing measured in this combination.</span></li>`;
  const stack = $('.cmp-stack'); if (stack) { const h = $('.handle', stack); if (h) h.onkeydown = ev => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); S.cmp.pos = Math.max(0, Math.min(100, S.cmp.pos + (ev.key === 'ArrowLeft' ? -5 : 5))); stack.style.setProperty('--pos', S.cmp.pos + '%'); h.setAttribute('aria-valuenow', S.cmp.pos); } }; }
}
let dragging = null;
const slide = ev => { if (!dragging) return; const r = dragging.getBoundingClientRect(); S.cmp.pos = Math.round(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100))); dragging.style.setProperty('--pos', S.cmp.pos + '%'); const h = $('.handle', dragging); if (h) h.setAttribute('aria-valuenow', S.cmp.pos); };
document.addEventListener('pointerdown', ev => { const s = ev.target.closest('.cmp-stack[data-mode="slider"]'); if (s) { dragging = s; slide(ev); } });
document.addEventListener('pointermove', slide);
document.addEventListener('pointerup', () => { dragging = null; });

/* the brief the agent gets: short on purpose */
const FIX = { xss: 'Render the message as text, not HTML.', crash: 'Put the empty-cart guard back and answer 400 "cart is empty".', rtl: 'Use inset-inline-end for the badge and min-width for the button.', mut: 'Add tests that pin the percent and fixed discounts.', contrast: 'Use the dark theme’s dim text colour (#b0adc9).', dep: 'Use a package you already depend on, or review and pin this one.', scope: 'Say whether it is wanted; otherwise remove it.', round: 'Only if a test shows a one-cent drift.' };
function briefText() {
  const v = verdict(); const line = (i, n) => `${n}. ${i.title}. ${i.file}:${i.lines}. ${FIX[i.id]} Replay: assay replay ${i.evidence[0].id}`;
  const parts = [`Fix brief: ${PROJECT.name}, ${rangeCommits().length} commits (${rangeTitle()})`, ''];
  if (v.must.length) parts.push('MUST FIX (proven, blocks the merge):', ...v.must.map((i, k) => line(i, k + 1)), '');
  if (v.should.length) parts.push('SHOULD FIX (proven, does not block):', ...v.should.map((i, k) => line(i, k + 1)), '');
  if (v.decide.length) parts.push('ASK THE PERSON:', ...v.decide.map(i => `- ${i.title}`), '');
  parts.push('Do not touch anything else. After the fix, run: assay recheck');
  return parts.join('\n');
}
ACT.brief = () => { const t = briefText(); $('#brieftext').value = t; $('#briefmeta').textContent = `${t.split(/\s+/).length} words, roughly ${Math.round(t.split(/\s+/).length * 1.4)} tokens. Evidence is replayed by id, not pasted.`; $('#brief').showModal(); };
ACT.copybrief = async el => morph(el, async () => { const ta = $('#brieftext'); try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); } await sleep(300); }, { busy: 'Copying…', done: 'Copied' });
ACT.closebrief = () => $('#brief').close();
ACT.simfix = async el => {
  await morph(el, () => sleep(1700), { busy: `Checking ${FIX_COMMIT.h}…`, done: 'Both checks pass', hold: 500 }); applyFix(); render(); announce('Fixed in ' + FIX_COMMIT.h);
};
function applyFix() {
  if (S.fixed) return; S.fixed = true; S.commits.unshift(FIX_COMMIT);
  if (S.mode !== 'branch') { S.to = S.commits[0].h; if (S.mode === 'single') S.from = S.to; }
  if (S.panel.state === 'done') { S.panel.tokens += 1900; S.panel.cover.push(FIX_COMMIT.h); S.panel.fixInfo = 'Re-checked 2 of 9 changes, reused 7 verdicts, 1.9k tokens'; }
  else S.panel.fixInfo = 'Only the 2 changed hunks were checked; the other results were reused';
  S.sel = null;
}

/* ------------------------------------------------------------------ reviewers */
function makePlan() {
  const lenses = new Set(rangeCommits().flatMap(c => c.lenses)); const budget = S.budget * 1000; const out = { tri: null, rev: [], cross: null, adv: null, total: 0 };
  if (budget === 0) { const why = 'Free only: the reviewers stay off.'; out.tri = { run: false, tokens: 0, reason: why }; REVIEWERS.forEach(r => out.rev.push({ r, run: false, tokens: 0, reason: why, kind: 'off' })); out.cross = { run: false, tokens: 0 }; out.adv = { run: false, tokens: 0 }; return out; }
  let used = TRIAGE_TOKENS; out.tri = { run: true, tokens: TRIAGE_TOKENS, reason: 'Reads the request and traces every changed file to it.' };
  REVIEWERS.forEach(r => {
    if (!lenses.has(r.lens)) out.rev.push({ r, run: false, tokens: 0, reason: r.skip, kind: 'not needed' });
    else if (used + r.tokens + CROSS_TOKENS <= budget) { used += r.tokens; out.rev.push({ r, run: true, tokens: r.tokens, reason: r.why }); }
    else out.rev.push({ r, run: false, tokens: 0, reason: `Over budget: needs ${fmtK(r.tokens)}, ${fmtK(Math.max(0, budget - used - CROSS_TOKENS))} left.`, kind: 'budget' });
  });
  const n = out.rev.filter(x => x.run).length;
  out.cross = n >= 2 ? { run: true, tokens: CROSS_TOKENS } : { run: false, tokens: 0 }; used += out.cross.tokens;
  out.adv = budget >= 80000 && n ? { run: true, tokens: ADV_TOKENS } : { run: false, tokens: 0 }; used += out.adv.tokens; out.total = used; return out;
}
ACT.runPanel = () => { go('reviewers'); runPanel(); };
async function runPanel() {
  if (S.panel.state === 'running') return; const plan = makePlan(); if (S.budget === 0) return;
  const P = S.panel = { state: 'running', plan, st: { chk: 'done', tri: 'queued', spec: 'queued', cross: 'queued', gate: 'queued', verdict: 'queued' }, rs: {}, ran: {}, cover: rangeHashes(), tokens: 0, by: { tri: 0, spec: 0, cross: 0, adv: 0 }, gate: null, fixInfo: '' };
  const draw = () => { const { page } = parseHash(); if (page === 'reviewers' || page === 'case') render(); };
  plan.rev.forEach(x => { P.rs[x.r.id] = x.run ? 'queued' : 'skipped'; }); draw();
  P.st.tri = 'running'; draw(); await sleep(800); P.st.tri = 'done'; P.ran.tri = true; P.tokens += TRIAGE_TOKENS; P.by.tri = TRIAGE_TOKENS; draw();
  P.st.spec = 'running'; const runs = plan.rev.filter(x => x.run);
  await Promise.all(runs.map(async (x, i) => { await sleep(200 * i); P.rs[x.r.id] = 'running'; draw(); await sleep(1000 + 260 * i); P.rs[x.r.id] = 'done'; P.ran[x.r.id] = true; P.tokens += x.tokens; P.by.spec += x.tokens; draw(); }));
  P.st.spec = 'done'; draw();
  if (plan.cross.run) { P.st.cross = 'running'; draw(); await sleep(900); if (plan.adv.run) { await sleep(900); P.tokens += ADV_TOKENS; P.by.adv = ADV_TOKENS; } P.tokens += CROSS_TOKENS; P.by.cross = CROSS_TOKENS; P.st.cross = 'done'; } else P.st.cross = 'skipped'; draw();
  P.st.gate = 'running'; draw(); await sleep(700);
  const kept = visibleItems().length; const dropped = runs.length >= 3 ? 3 : runs.length ? 1 : 0; P.gate = { kept, dropped, claims: kept + dropped };
  P.st.gate = 'done'; P.st.verdict = 'done'; P.state = 'done'; draw(); announce('Reviewers finished');
}
ACT.budget = el => { if (S.panel.state === 'running') return; S.budget = +el.value; S.panel = freshPanel(); render(); };
const revFindings = r => visibleItems().filter(i => i.flaggedBy.includes(r.name)).length;
function pageReviewers() {
  const P = S.panel; const plan = P.state === 'idle' ? makePlan() : P.plan || makePlan(); const idle = P.state === 'idle';
  const stepState = k => idle ? 'pending' : P.st[k] || 'pending';
  const steps = [
    ['chk', 'Free checks', '0 tokens', 'done'],
    ['tri', 'Triage', plan.tri.run ? `~${fmtK(plan.tri.tokens)}` : 'off', stepState('tri')],
    ['spec', 'Specialists', `${plan.rev.filter(x => x.run).length} of 6 · blind`, stepState('spec')],
    ['cross', plan.adv.run ? 'Cross-exam + attack' : 'Cross-exam', plan.cross.run ? `~${fmtK(plan.cross.tokens + plan.adv.tokens)}` : 'skipped', plan.cross.run ? stepState('cross') : (idle ? 'skipped' : 'skipped')],
    ['gate', 'Evidence gate', 'no proof, no vote', stepState('gate')],
    ['verdict', 'Verdict', 'proven blocks', stepState('verdict')]];
  const stepsHTML = steps.map(([k, n, s, st], i) => `<div class="step ${st === 'running' ? 'running' : st === 'done' ? 'done' : st === 'skipped' ? 'skipped' : ''}"><span class="n">${i + 1}</span><b>${n}</b><small>${st === 'running' ? 'running…' : s}</small></div>`).join('');
  const cards = plan.rev.map(x => {
    const r = x.r; const st = idle ? (x.run ? 'will' : 'skip') : P.rs[r.id] || 'skipped'; const cls = st === 'running' ? 'running' : (st === 'skip' || st === 'skipped') ? 'skipped' : '';
    const badge = st === 'running' ? `<span class="badge badge-ai"><span class="dot dot-pulse"></span>Working</span>` : st === 'done' ? `<span class="badge badge-ok">${ico.check}Done</span>` : st === 'queued' ? '<span class="badge">Queued</span>' : st === 'will' ? '<span class="badge badge-accent">Will run</span>' : `<span class="badge">${x.kind === 'budget' ? 'Over budget' : x.kind === 'off' ? 'Off' : 'Not needed'}</span>`;
    const f = st === 'done' ? revFindings(r) : null;
    return `<div class="rcard ${cls}"><div class="rtop"><span class="rname">${e(r.name)}</span><span class="right">${badge}</span></div><p class="why-line">${e(x.reason)}</p><p class="blind">${ico.lock} Blind: can’t see the others until cross-exam</p><div class="rfoot"><span>${x.run ? '~' + fmtK(x.tokens) + ' tokens' : '0 tokens'}</span><span>${f != null ? f + ' finding' + (f === 1 ? '' : 's') : ''}</span></div></div>`; }).join('');
  const total = Math.max(plan.total, 1), cap = Math.max(S.budget * 1000, 1); const used = idle ? plan.total : P.tokens;
  const seg = (v, c) => `<i class="${c}" style="width:${Math.min(100, (v / cap) * 100)}%"></i>`;
  const by = idle ? { tri: plan.tri.tokens, spec: plan.rev.reduce((a, x) => a + x.tokens, 0), cross: plan.cross.tokens, adv: plan.adv.tokens } : P.by;
  const freeProven = visibleItems().filter(i => i.src === 'free' && i.tier === 'proven').length; const allVis = visibleItems().length;
  const saved = plan.rev.filter(x => x.kind === 'not needed').reduce((a, x) => a + x.r.tokens, 0);
  const perFinding = idle || !allVis ? '—' : fmtK(Math.round(P.tokens / Math.max(1, visibleItems().filter(i => i.src === 'panel').length)));
  const meter = `<div class="card card-pad meter"><div class="section-head"><span class="card-title">Tokens ${idle ? '(preview)' : ''}</span><span class="dim">${fmtK(used)} of ${S.budget ? S.budget + 'k' : '0'} budget</span></div>
    <div class="meterbar" role="img" aria-label="${fmtK(used)} tokens of ${S.budget}k">${seg(by.tri, 't1')}${seg(by.spec, 't2')}${seg(by.cross, 'tc')}${seg(by.adv, 't3')}</div>
    <div class="meterlegend"><span style="--c:var(--h-violet-fill)">Triage ${fmtK(by.tri)}</span><span style="--c:var(--second)">Specialists ${fmtK(by.spec)}</span><span style="--c:var(--h-blue-fill)">Cross-exam ${fmtK(by.cross)}</span>${by.adv ? `<span style="--c:var(--h-orange-fill)">Attack pass ${fmtK(by.adv)}</span>` : ''}</div>
    <div class="bignums"><div class="bignum"><b>${freeProven} of ${allVis}</b><span>findings the free checks already proved, at 0 tokens</span></div><div class="bignum"><b>~${fmtK(saved)}</b><span>tokens not spent: lenses this range doesn’t touch</span></div><div class="bignum"><b>${perFinding}</b><span>tokens per reviewer-added finding</span></div></div></div>`;
  const cross = P.state === 'done' ? `<div class="card card-pad" style="display:flex;flex-direction:column;gap:12px"><div class="card-title">Cross-exam and the evidence gate</div>
    ${P.plan.cross.run ? `<div class="callout callout-ai">${ico.users}<div><b>One disagreement settled.</b> Correctness said the order total may drift by a cent. Tests wrote 40 cases and none was off. Result: kept as a <b>hint</b>, which can’t block a merge.</div></div>` : '<p class="dim">Fewer than two reviewers ran, so there was nobody to cross-examine.</p>'}
    <p><b>${P.gate.claims}</b> claims came in. <b>${P.gate.kept}</b> had evidence and are kept (some from the free checks). <b>${P.gate.dropped}</b> were dropped for having none:</p>
    <ul class="dropped">${DROPPED.slice(0, P.gate.dropped).map(d => `<li>${ico.x}<span><s>${e(d.claim)}</s> · ${e(d.why)}</span></li>`).join('')}</ul>
    <div class="toolbar"><a class="btn btn-primary" href="#/case">${ico.file} Back to the case file</a></div></div>` : '';
  const head = `<div class="page-head"><div><h1 class="page-title">Reviewers</h1><p class="page-sub">Independent, blind, one lens each. Nothing they say counts without evidence.</p></div>
    <div class="toolbar"><label class="dim" for="budget">Budget</label><select id="budget" data-chg="budget" ${P.state === 'running' ? 'disabled' : ''}>${[[0, 'Free only'], [20, '20k tokens'], [40, '40k tokens'], [80, '80k tokens']].map(([v, l]) => `<option value="${v}" ${S.budget === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${P.state === 'running' ? '<button class="btn btn-second" disabled><span class="spinner"></span> Running</button>' : `<button class="btn btn-second" data-act="runPanel" ${S.budget === 0 ? 'disabled' : ''}>${ico.users} ${P.state === 'done' ? 'Run again' : 'Run reviewers'} · ~${fmtK(plan.total)}</button>`}</div></div>`;
  const tabs = `<div class="segmented" role="group" aria-label="Reviewers"><button data-act="rtab" data-v="panel" aria-pressed="${S.rtab === 'panel'}">The panel</button><button data-act="rtab" data-v="score" aria-pressed="${S.rtab === 'score'}">Scoreboard</button></div>`;
  const note = idle ? `<div class="callout">${ico.search}<div><b>This is a preview.</b> ${plan.rev.filter(x => x.run).length} of 6 reviewers would run for ${rangeCommits().length} commit${rangeCommits().length > 1 ? 's' : ''}, about ${fmtK(plan.total)} tokens. The free checks cost nothing and have already run. Change the budget to see what drops out.</div></div>` : '';
  return `<div class="page page-wide">${head}${tabs}${S.rtab === 'score' ? pageScore() : `${note}<div class="stepper">${stepsHTML}</div><div class="rgrid">${cards}</div>${meter}${cross}`}</div>`;
}
ACT.rtab = el => { S.rtab = el.dataset.v; sync(); render(); };

/* scoreboard: reviewers are tested by planting known bugs */
const calStats = n => CAL_ROWS.map((r, ci) => { let C = 0, h = 0, m = 0; CAL_BUGS.slice(0, n).forEach(([, s]) => { const ch = s[ci]; if (ch === 'C') C++; else if (ch === 'h') h++; else if (ch === 'm') m++; }); return { ...r, C, h, m }; });
const ADVICE = { chk: 'Keep. Free.', sec: 'Keep.', cor: '3 false alarms: cross-exam keeps them as hints.', tst: 'Keep: cheap per catch.', ui: 'Keep.', sup: 'Run only when a dependency list changes.', perf: 'Run only when a loop or query changes.', plain: 'Real bugs and false alarms, none with proof.' };
function pageScore() {
  const n = S.cal.n; const st = calStats(n); const done = S.cal.state === 'done';
  const union = CAL_BUGS.slice(0, n).filter(([, s]) => s.slice(0, 7).includes('C')).length; const free = CAL_BUGS.slice(0, n).filter(([, s]) => s[0] === 'C').length;
  const btn = `<button class="btn btn-second" data-act="inject" ${S.cal.state === 'running' ? 'disabled' : ''}>${S.cal.state === 'running' ? '<span class="spinner"></span> Planting bugs…' : ico.play + ' Plant 12 bugs and test the reviewers'}</button>`;
  if (!n) return `<div class="card card-pad" style="display:flex;flex-direction:column;gap:12px;align-items:flex-start"><div class="card-title">Who do you trust?</div><p class="dim" style="max-width:62ch">Assay plants known bugs in a throwaway copy of your code, then checks which reviewer finds what, with and without proof. It also reviews clean code to count false alarms. Reviewers that don’t earn their tokens get routed out.</p>${btn}</div>`;
  const rows = st.map(r => `<tr><td><b>${e(r.name)}</b></td><td class="num">${r.C}</td><td class="num">${r.h}</td><td class="num">${r.m}</td><td class="num">${r.alarms}</td><td class="num">${r.C ? fmtK(Math.round(r.tokens / r.C)) : r.tokens ? '—' : '0'}</td><td class="dim">${done ? e(ADVICE[r.id]) : ''}</td></tr>`).join('');
  const colH = CAL_ROWS.map(r => `<div title="${e(r.name)}">${e(r.name.replace('One plain AI review (no gate)', 'Plain').replace('Free checks (no model)', 'Free').replace('UI & accessibility', 'UI').replace('Supply chain', 'Supply').replace('Performance', 'Perf'))}</div>`).join('');
  const mrows = CAL_BUGS.slice(0, n).map(([name, s], k) => `<div class="mx-row"><div>${k + 1}. ${e(name)}</div>${[...s].map((ch, ci) => `<div class="${CAL_ROWS[ci].plain ? 'plain-row' : ''}"><span class="${ch === '-' ? 'na' : ch}" title="${ch === 'C' ? 'Caught, with proof' : ch === 'h' ? 'Flagged, no proof' : ch === 'm' ? 'Missed' : 'Not this reviewer’s lens'}">${ch === 'C' ? '✓' : ch === 'h' ? '~' : ch === 'm' ? '✗' : '·'}</span></div>`).join('')}</div>`).join('');
  return `<div class="toolbar">${btn}</div>
    <div class="callout callout-ai">${ico.shield}<div><b>${free} of ${n} planted bugs were caught by the free checks alone, with proof, at 0 tokens.</b> With the reviewers: ${union} of ${n}.${done ? ' Only bug 5 (a removed null check) stayed a hint.' : ''}</div></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Reviewer</th><th class="num" title="Caught, with proof">Caught</th><th class="num" title="Flagged without proof">Flagged only</th><th class="num">Missed</th><th class="num" title="Flags on clean code">False alarms</th><th class="num">Tokens per catch</th><th>What it suggests</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="mx" role="table" aria-label="Which reviewer caught which planted bug"><div class="mx-row mx-head"><div>Planted bug</div>${colH}</div>${mrows}</div>
    <div class="legend"><span><b style="color:var(--ok)">✓</b> caught with proof</span><span><b style="color:var(--warn-ink)">~</b> flagged, no proof</span><span><b style="color:var(--danger)">✗</b> missed</span><span>· not its lens</span><span>Sample numbers: yours would come from your own repos.</span></div>`;
}
ACT.inject = async () => { S.cal = { state: 'running', n: 0 }; render(); for (let i = 1; i <= CAL_BUGS.length; i++) { await sleep(330); S.cal.n = i; if (parseHash().page === 'reviewers') render(); } S.cal.state = 'done'; render(); announce('Calibration done'); };

/* ------------------------------------------------------------------ memory */
const allMem = () => [...MEMORY, ...MINED.filter(m => S.mem.added[m.id])];
const eff = m => { const a = S.mem.adj[m.id] || { hits: 0, fp: 0 }; return { hits: m.hits + a.hits, fp: m.fp + a.fp }; };
function memStatus(m) { const { hits, fp } = eff(m); if (!hits) return ['New', 'badge-accent']; return fp / hits >= 0.3 ? ['Expiring', 'badge-warn'] : ['Active', 'badge-ok']; }
function memListHTML() {
  const q = S.mem.q.toLowerCase(); const list = allMem().filter(m => (S.mem.kind === 'all' || m.kind === S.mem.kind) && (!q || (m.name + m.ref + m.langs + m.id).toLowerCase().includes(q)));
  if (!list.length) return '<div class="zero">Nothing matches.</div>';
  return list.map(m => { const { hits, fp } = eff(m); const [s, c] = memStatus(m); return `<button class="memrow" data-act="mem" data-id="${m.id}" aria-pressed="${S.mem.sel === m.id}"><span class="mono dim">${m.id}</span><span><b>${e(m.name)}</b><br><span class="dim" style="font-size:var(--t-xs)">${e(m.ref)} · ${e(m.langs)}</span></span><span class="badge ${c}">${s} · ${hits}</span></button>`; }).join('');
}
function pageMemory() {
  const tabs = `<div class="segmented" role="group" aria-label="Memory">${[['mistakes', 'Mistakes'], ['standards', 'Standards'], ['mine', 'Learn from history']].map(([k, l]) => `<button data-act="mtab" data-v="${k}" aria-pressed="${S.mtab === k}">${l}</button>`).join('')}</div>`;
  return `<div class="page page-wide"><div class="page-head"><div><h1 class="page-title">Memory</h1><p class="page-sub">Mistakes this project has made, and the standards each one is checked against. Stats keep it honest: what cries wolf expires.</p></div></div>${tabs}${S.mtab === 'mistakes' ? memMistakes() : S.mtab === 'standards' ? memStandards() : memMine()}</div>`;
}
function memMistakes() {
  const m = memById(S.mem.sel) && allMem().includes(memById(S.mem.sel)) ? memById(S.mem.sel) : allMem()[0]; const { hits, fp } = eff(m); const [s, c] = memStatus(m); const rate = hits ? Math.round(fp / hits * 100) : 0;
  const matched = ITEMS.filter(i => i.memory.includes(m.id) && inRange().includes(i));
  const mx = Math.max(1, ...m.weeks);
  return `<div class="mem"><div class="card"><div class="card-head"><div class="segmented" role="group" aria-label="Kind">${[['all', 'All'], ['standard', 'Standard'], ['learned', 'Learned here']].map(([k, l]) => `<button data-act="mkind" data-v="${k}" aria-pressed="${S.mem.kind === k}">${l}</button>`).join('')}</div><input id="memq" class="input right" style="min-width:140px" type="search" placeholder="Search" value="${e(S.mem.q)}" aria-label="Search mistakes"></div><div id="memlist">${memListHTML()}</div></div>
    <article class="card"><div class="detail-head"><div class="badges"><span class="mono dim">${m.id}</span><span class="badge ${c}">${s}</span><span class="badge ${m.kind === 'learned' ? 'badge-ai' : 'badge-accent'}">${m.kind === 'learned' ? 'Learned here' : 'Standard'}</span><span class="badge">${e(m.ref)}</span><span class="chip-lang">${e(m.langs)}</span></div><h3>${e(m.name)}</h3><p class="dim">${e(m.from)}</p></div>
    <div class="tabbody"><div class="facts"><div class="k">Detector</div><div>${e(m.det)}</div><div class="k">Seen</div><div>${hits} times, last ${e(m.last)}</div><div class="k">Dismissed as false alarms</div><div><span class="fpbar"><i><b style="width:${rate}%"></b></i>${fp} of ${hits} (${rate}%)</span></div><div class="k">Last 12 weeks</div><div><span class="spark" role="img" aria-label="Hits per week">${m.weeks.map(w => `<i style="height:${Math.max(2, w / mx * 26)}px"></i>`).join('')}</span></div></div>
      <div class="kv" style="grid-template-columns:1fr 1fr"><div class="h">Bad</div><div class="h">Good</div><div class="bad mono">${e(m.bad)}</div><div class="good mono">${e(m.good)}</div></div>
      ${s === 'Expiring' ? `<div class="callout">${ico.alert}<div>More than 30% of the alarms were dismissed. With no real hit for 60 days this entry switches itself off.</div></div>` : ''}
      ${matched.length ? `<div class="callout callout-ai">${ico.file}<div><b>Matched in the current case:</b> ${matched.map(i => `<a href="#/case?item=${i.id}">${e(i.title)}</a>`).join(' · ')}</div></div>` : '<p class="dim">Not matched in the current case.</p>'}</div></article></div>`;
}
ACT.mem = el => { S.mem.sel = el.dataset.id; sync(); render(); };
ACT.mkind = el => { S.mem.kind = el.dataset.v; render(); };
ACT.mtab = el => { S.mtab = el.dataset.v; sync(); render(); };
function memStandards() {
  const on = PACKS.filter(p => S.packs[p.id] ?? p.on); const auto = on.reduce((a, p) => a + p.auto, 0), rules = on.reduce((a, p) => a + p.rules, 0);
  return `<div class="card"><div class="card-head"><span class="card-title">Standards packs</span><span class="dim">${on.length} on · ${auto} of ${rules} rules can be checked by a machine; the rest become questions for a reviewer</span></div>
    ${PACKS.map(p => { const v = S.packs[p.id] ?? p.on; return `<div class="pack"><label class="check"><input type="checkbox" data-chg="pack" data-id="${p.id}" ${v ? 'checked' : ''} aria-label="${e(p.name)}"></label><div><b>${e(p.name)}</b> <span class="badge">${e(p.ver)}</span><br><span class="dim">${e(p.warn || p.note || '')}</span></div><div style="text-align:right"><span class="dim" style="font-size:var(--t-xs)">${p.auto} of ${p.rules} machine-checkable</span><span class="autobar"><b style="width:${p.auto / p.rules * 100}%"></b></span></div></div>`; }).join('')}</div>
    <p class="dim">Packs are plain files you can read and edit, so a new edition of a standard is a file update, not a release.</p>`;
}
ACT.pack = el => { S.packs[el.dataset.id] = el.checked; render(); };
function memMine() {
  return `<div class="card card-pad" style="display:flex;flex-direction:column;gap:12px"><div class="card-title">Learn from your own history</div><p class="dim" style="max-width:66ch">Every “fix:” commit is a mistake someone already paid for. Assay reads them, groups the ones that look alike, and suggests a detector for each. You decide what gets added.</p>
    <div><button class="btn btn-second" data-act="mine">${ico.search} ${S.mem.mined ? 'Read the history again' : 'Read the git history'}</button></div>
    ${S.mem.mined ? `<div class="callout">${ico.check}<div>Read 412 commits. <b>38</b> are fixes, in <b>9</b> groups. Three groups look worth a detector.</div></div><div class="card">${MINED.map(m => `<div class="pack" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${e(m.name)}</b><br><span class="dim">${e(m.from)}</span></div>${S.mem.added[m.id] ? `<span class="badge badge-ok">${ico.check} Added</span>` : `<button class="btn btn-sm" data-act="addmined" data-id="${m.id}">Add detector</button>`}</div>`).join('')}</div>` : ''}</div>`;
}
ACT.mine = async el => { await morph(el, () => sleep(1600), { busy: 'Reading 412 commits…', done: 'Found 38 fixes', hold: 400 }); S.mem.mined = true; render(); };
ACT.addmined = async el => { const id = el.dataset.id; await morph(el, () => sleep(500), { busy: 'Adding…', done: 'Added', hold: 300 }); S.mem.added[id] = true; render(); };

/* ------------------------------------------------------------------ settings */
function pageSettings() {
  const sym = { b: 'In the first build', a: 'Small adapter', n: 'Not yet' }; const mark = { b: '✓', a: '◐', n: '–' };
  return `<div class="page"><div class="page-head"><div><h1 class="page-title">Settings</h1><p class="page-sub">What Assay uses, and what it costs.</p></div></div>
    <section class="section"><h2 class="section-title">Appearance</h2><div class="segmented" role="group" aria-label="Theme">${[['auto', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button data-act="theme" data-v="${v}" aria-pressed="${S.theme === v}">${l}</button>`).join('')}</div></section>
    <section class="section"><h2 class="section-title">Default budget</h2><div class="toolbar"><label for="b2" class="dim">Tokens the reviewers may spend per case</label><select id="b2" data-chg="budget">${[[0, 'Free only'], [20, '20k'], [40, '40k'], [80, '80k']].map(([v, l]) => `<option value="${v}" ${S.budget === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><p class="dim">The free checks never use tokens. The reviewers only look where the free checks say something changed.</p></section>
    <section class="section"><h2 class="section-title">Evidence providers</h2><p class="dim">Assay doesn’t rebuild what exists. It calls it, and keeps the results.</p><div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Provider</th><th>Gives</th><th>State</th></tr></thead><tbody>${PROVIDERS.map(p => `<tr><td><b>${e(p.name)}</b></td><td class="dim">${e(p.gives)}</td><td><span class="badge ${p.state === 'found' ? 'badge-ok' : ''}">${p.state === 'found' ? ico.check + ' Found' : 'Optional'}</span> <span class="dim">${e(p.how)}</span></td></tr>`).join('')}</tbody></table></div></div></section>
    <section class="section"><h2 class="section-title">Languages</h2><div class="card"><div class="table-wrap"><table class="lang"><thead><tr><th>Language</th>${LANG_COLS.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${LANGS.map(r => `<tr><td>${e(r[0])}</td>${r.slice(1).map(v => `<td class="${v}" title="${sym[v]}">${mark[v]}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
      <div class="legend"><span><b style="color:var(--ok)">✓</b> in the first build</span><span><b style="color:var(--warn-ink)">◐</b> small adapter per language</span><span>– not yet</span></div>
      <p class="dim">Every language, even the last row, still gets the git diff, the project’s own test command (read as JUnit XML), black-box checks on its HTTP and its pages, and the secret scan.</p></section></div>`;
}
ACT.theme = el => { S.theme = el.dataset.v; const r = document.documentElement; if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme); try { localStorage.setItem('assay-theme', S.theme); } catch {} MX = null; render(); };

/* ------------------------------------------------------------------ palette (Ctrl K) */
let palSel = 0, palItems = [];
function palAll() {
  return [...PAGES.map(([id, l]) => ({ label: 'Go to ' + l, hint: 'page', run: () => go(id) })), { label: 'Go to Settings', hint: 'page', run: () => go('settings') },
    ...S.commits.map(c => ({ label: `Review ${c.h}: ${c.m}`, hint: 'commit', run: () => { S.mode = 'single'; S.from = S.to = c.h; S.sel = null; go('case'); } })),
    { label: 'Run the reviewers', hint: 'action', run: () => { go('reviewers'); runPanel(); } }, { label: 'Plant 12 bugs and test the reviewers', hint: 'action', run: () => { S.rtab = 'score'; go('reviewers', { tab: 'score' }); ACT.inject(); } }];
}
function palDraw() {
  const q = $('#palq').value.toLowerCase(); palItems = palAll().filter(x => x.label.toLowerCase().includes(q)).slice(0, 9); palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  $('#pallist').innerHTML = palItems.map((x, i) => `<li><button type="button" data-pi="${i}" aria-selected="${i === palSel}"><span>${e(x.label)}</span><span class="dim right">${x.hint}</span></button></li>`).join('') || '<li class="zero">Nothing matches.</li>';
}
function palOpen() { const d = $('#pal'); palSel = 0; $('#palq').value = ''; palDraw(); if (!d.open) d.showModal(); $('#palq').focus(); }
document.addEventListener('keydown', ev => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); palOpen(); } });
function palRun() { const x = palItems[palSel]; if (x) { $('#pal').close(); x.run(); } }
ACT.palOpen = palOpen;

/* ------------------------------------------------------------------ boot */
function boot() {
  const g = [...'...xxxxx....|..x.....x...|.x.sss...x..|.xsssss..x..|.x.sss...x..|.x.......x..|..x.....xx..|...xxxxx.xx.|.........xxx|..........xx|............|............'.split('|')];
  let rects = ''; g.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'x') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="var(--accent)"/>`; else if (c === 's') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="var(--marker)"/>`; }));
  $('#brand').innerHTML = `<svg class="brand-mark" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg><span class="brand-name">assay</span>`;
  try { const t = localStorage.getItem('assay-theme'); if (t && t !== 'auto') { S.theme = t; document.documentElement.setAttribute('data-theme', t); } } catch {}
  $('#palq').addEventListener('input', () => { palSel = 0; palDraw(); });
  $('#palq').addEventListener('keydown', ev => { if (ev.key === 'ArrowDown') { ev.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); palDraw(); } else if (ev.key === 'ArrowUp') { ev.preventDefault(); palSel = Math.max(0, palSel - 1); palDraw(); } else if (ev.key === 'Enter') { ev.preventDefault(); palRun(); } });
  $('#pallist').addEventListener('click', ev => { const b = ev.target.closest('[data-pi]'); if (b) { palSel = +b.dataset.pi; palRun(); } });
  window.addEventListener('hashchange', route);
  route();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { MX = null; render(); });
}
boot();
