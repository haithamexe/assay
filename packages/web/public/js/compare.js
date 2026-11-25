import { ACT, S, render } from './state.js';
import { html, ico, short } from './lib.js';

/* Before and after, from the pictures Assay took of the real pages at the base and at the head. The red boxes are measured on the
   page by the browser, not drawn by hand: they are placed from the layout as a share of the window's size. */

const VIEWPORT = { desktop: [1280, 800], phone: [390, 844] };
const SAME = 0.0001;
const ORDER = ['desktop|light|native', 'desktop|light|rtl', 'phone|light|native'];

/** The pictures that belong to a finding: those of the pages its evidence is about. */
export function shotsFor(view, f) {
  const pages = new Set(f.evidence.map(e => (e.replay && e.replay.run && e.replay.run.kind === 'look' ? e.replay.run.file : null)).filter(Boolean));
  if (!pages.size) return [];
  return view.case.runs.flatMap(r => r.shots || []).filter(s => pages.has(s.page)).sort((a, b) => ORDER.indexOf(a.combo) - ORDER.indexOf(b.combo) || a.page.localeCompare(b.page));
}

const KIND = { overlap: 'Overlap', clip: 'Cut off', contrast: 'Low contrast', hscroll: 'Sideways scroll', noalt: 'No alt text', noname: 'No name', nolabel: 'No label' };

/** What a finding measured: its evidence says which kind of problem it is about, so a picture only marks that kind. */
export function kindsOf(f) {
  return new Set(f.evidence.map(e => (String(e.source).startsWith('browser:') ? e.source.slice(8) : null)).filter(Boolean));
}

const label = s => {
  const [vp, scheme, dir] = s.combo.split('|');
  return `${vp === 'phone' ? 'Phone' : 'Desktop'} · ${dir === 'rtl' ? 'mirrored' : 'as loaded'}${scheme === 'dark' ? ' · dark' : ''}`;
};
const url = (caseId, name) => `/api/shot?case=${encodeURIComponent(caseId)}&name=${encodeURIComponent(name)}`;
const pct = (n, d) => Math.max(0, Math.min(100, Math.round((n / d) * 10000) / 100));
const trim = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function compareHTML(c, shots, kinds) {
  const marksOf = x => (x.marks || []).filter(m => kinds.has(m.kind));
  // Not chosen yet: start on the first picture that has something measured in it.
  const k = S.cmp.shot >= 0 ? Math.min(S.cmp.shot, shots.length - 1) : Math.max(0, shots.findIndex(x => marksOf(x).length));
  const s = shots[k];
  const vpId = s.combo.split('|')[0];
  const [vw, vh] = VIEWPORT[vpId] || VIEWPORT.desktop;
  const marks = marksOf(s);
  const mode = S.cmp.mode;
  const seg = (items, cur, act) => html`<div class="segmented" role="group" aria-label="How to compare">${items.map(([v, l]) => html`<button data-act="${act}" data-v="${v}" aria-pressed="${String(cur === v)}">${l}</button>`)}</div>`;
  const cells = shots.map((x, i) => {
    const n = marksOf(x).length;
    const st = n ? html`<span class="st bad">${ico.x}${n} problem${n > 1 ? 's' : ''}</span>` : x.changed >= SAME ? html`<span class="st">${ico.eye}looks different · ${(x.changed * 100).toFixed(1)}%</span>` : html`<span class="st ok">${ico.check}no visible change</span>`;
    return html`<button class="mcell" data-act="shot" data-v="${i}" aria-pressed="${String(i === k)}">${st}<span class="dim">${label(x)}${new Set(shots.map(y => y.page)).size > 1 ? html` · ${x.page}` : ''}</span></button>`;
  });
  const flags = marks.map(m => html`<div class="flag" data-css="left:${pct(m.x, vw)}%;top:${pct(m.y, vh)}%;width:${pct(m.w, vw)}%;height:${pct(m.h, vh)}%"><em>${KIND[m.kind] || m.kind}</em></div>`);
  const head = url(c.id, s.head);
  const base = url(c.id, s.base);
  const diff = url(c.id, s.diff);
  const inner = `stage-inner shots ${vpId}`;
  const stage = mode === 'side'
    ? html`<div class="stage"><div class="stage-inner shots wide"><div class="cmp-side"><figure><figcaption>Before · ${c.base ? short(c.base) : 'start'}</figcaption><div class="flagbox"><img class="cmp-img" src="${base}" alt="The page before"></div></figure><figure><figcaption>After · ${short(c.head)}</figcaption><div class="flagbox"><img class="cmp-img" src="${head}" alt="The page after"><div class="flags">${flags}</div></div></figure></div></div></div>`
    : mode === 'diff'
      ? html`<div class="stage"><div class="${inner}"><div class="cmp-stack flagbox" data-mode="diff"><div class="layer after"><img class="cmp-img" src="${diff}" alt="What changed, in orange"></div><div class="flags">${flags}</div></div></div></div>`
      : html`<div class="stage"><div class="${inner}"><div class="cmp-stack flagbox" data-mode="slider" data-css="--pos:${S.cmp.pos}%"><div class="layer after" inert><img class="cmp-img" src="${head}" alt="The page after"></div><div class="layer before" inert><img class="cmp-img" src="${base}" alt="The page before"></div><div class="flags">${flags}</div><button class="handle" role="slider" aria-label="Compare before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${S.cmp.pos}"></button></div></div></div>`;
  return html`<div class="cmp-bar">${seg([['slider', 'Slider'], ['side', 'Side by side'], ['diff', 'Difference']], mode, 'cmpmode')}<span class="dim">${s.page} · ${(s.changed * 100).toFixed(2)}% of the pixels changed</span></div>
    <div class="cmp-matrix" role="group" aria-label="The pictures taken">${cells}</div>${stage}
    <div class="legend"><span>${mode === 'diff' ? 'Orange is what changed.' : mode === 'slider' ? 'Drag the handle, or use the arrow keys. Left of it is before.' : 'Before on the left, after on the right.'}</span><span>Red boxes are measured on the page, not drawn by hand.</span></div>
    <ul class="issues" aria-live="polite">${marks.length ? marks.map(m => html`<li>${ico.x}<span><b>${m.label}</b></span></li>`) : html`<li>${ico.check}<span>Nothing was measured in this picture that wasn’t there before.</span></li>`}</ul>`;
}

ACT.cmpmode = el => { S.cmp.mode = el.dataset.v; render(); };
ACT.shot = el => { S.cmp.shot = Number(el.dataset.v) || 0; render(); };

export function afterCompare() {
  const stack = document.querySelector('.cmp-stack[data-mode="slider"]');
  const h = stack && stack.querySelector('.handle');
  if (!h) return;
  h.onkeydown = ev => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    S.cmp.pos = Math.max(0, Math.min(100, S.cmp.pos + (ev.key === 'ArrowLeft' ? -5 : 5)));
    stack.style.setProperty('--pos', `${S.cmp.pos}%`);
    h.setAttribute('aria-valuenow', String(S.cmp.pos));
  };
}

let dragging = null;
function slide(ev) {
  if (!dragging) return;
  const r = dragging.getBoundingClientRect();
  S.cmp.pos = Math.round(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)));
  dragging.style.setProperty('--pos', `${S.cmp.pos}%`);
  const h = dragging.querySelector('.handle');
  if (h) h.setAttribute('aria-valuenow', String(S.cmp.pos));
}
document.addEventListener('pointerdown', ev => { const s = ev.target.closest('.cmp-stack[data-mode="slider"]'); if (s) { dragging = s; slide(ev); } });
document.addEventListener('pointermove', slide);
document.addEventListener('pointerup', () => { dragging = null; });
