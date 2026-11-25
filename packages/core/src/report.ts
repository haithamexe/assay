import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findingState, isOpen, verdictOf } from './case.js';
import { assayPath } from './config.js';
import { languageOf } from './lang.js';
import type { Case, CommitSummary, Finding, Tier } from './types.js';

/**
 * A static case file: one HTML page, fonts embedded, the Arcade look, a few lines of script to switch between findings.
 * Everything that came from git (subjects, paths, code, evidence text) is untrusted and escaped.
 */
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
/** Where the shared stylesheet and the three fonts live. The dashboard serves them from here, so there is one copy of the look. */
export const assetsDir = assets;
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const b64 = (f: string): string => fs.readFileSync(path.join(assets, 'fonts', f)).toString('base64');

const I = (p: string): string => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const ICON = {
  check: I('<path d="M5 12l5 5 9-10"/>'),
  stop: I('<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>'),
  alert: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>'),
  shield: I('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>')
};

const EXTRA_CSS = `
.shots { display: grid; gap: var(--s4); }
.shot figcaption { color: var(--text-dim); margin-bottom: var(--s2); }
.shot .stack { position: relative; display: grid; border: 1px solid var(--border); border-radius: var(--r1); overflow: hidden; --pos: 50%; }
.shot .stack img { grid-area: 1 / 1; width: 100%; display: block; }
.shot .stack img.b { clip-path: inset(0 calc(100% - var(--pos)) 0 0); z-index: 1; }
.shot .stack .rule { position: absolute; top: 0; bottom: 0; left: var(--pos); width: 2px; margin-left: -1px; background: var(--accent); z-index: 2; pointer-events: none; }
.shot input[type=range] { width: 100%; margin-top: var(--s2); accent-color: var(--accent); }
.shot details { margin-top: var(--s2); }
.shot details img { max-width: 100%; border: 1px solid var(--border); border-radius: var(--r1); }
.app.report { display: block; height: auto; min-height: calc(100vh - 2 * var(--sheet-gap)); }
.report .main { overflow: visible; padding: var(--s6) var(--s6) var(--s8); }
.report-head { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
.report-head .brand { padding: 0; }
.finding-detail[hidden] { display: none; }
.foot { color: var(--text-dim); font-size: var(--t-sm); }
.kbd { font-family: var(--mono); }
`;

const SCRIPT = `(function(){var items=[].slice.call(document.querySelectorAll('.citem'));
function show(id){items.forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.f===id))});
[].forEach.call(document.querySelectorAll('.finding-detail'),function(d){d.hidden=d.id!=='d-'+id});
try{history.replaceState(null,'','#'+id)}catch(e){}}
items.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.f)})});
[].forEach.call(document.querySelectorAll('.shot input'),function(i){i.addEventListener('input',function(){i.closest('.shot').querySelector('.stack').style.setProperty('--pos',i.value+'%')})});
var h=location.hash.slice(1);if(items.length)show(items.some(function(b){return b.dataset.f===h})?h:items[0].dataset.f)})();`;

const tierBadge = (t: Tier | 'fixed' | 'dismissed' | 'intended'): string =>
  `<span class="badge tier-${t === 'dismissed' ? 'intended' : t}">${t === 'proven' ? ICON.check : ''}${{ proven: 'Proven', corroborated: 'Corroborated', hint: 'Hint', fixed: 'Fixed in the range', dismissed: 'Dismissed', intended: 'Intended' }[t]}</span>`;
const sevBadge = (s: string): string => (s === 'high' ? '<span class="badge badge-danger">High</span>' : s === 'medium' ? '<span class="badge badge-warn">Medium</span>' : '<span class="badge">Low</span>');

function diffHTML(f: Finding): string {
  const rows = f.snippet.rows.map(r => `<div class="diff-row ${r.t === '-' ? 'del' : r.t === '+' ? 'add' : ''}${r.sig ? ' sig' : ''}"><span class="diff-no">${r.o ?? ''}</span><span class="diff-no r">${r.n ?? ''}</span><span class="diff-mark">${r.t === ' ' ? '' : r.t}</span><span class="diff-text">${esc(r.text)}</span></div>`).join('');
  return `<div class="diff-file"><div class="diff-file-head"><span class="mono">${esc(f.file)}</span></div>${f.snippet.header ? `<div class="diff-hunk-head mono">${esc(f.snippet.header)}</div>` : ''}<div class="diff-grid" tabindex="0" aria-label="Changed lines">${rows}</div></div>`;
}

function detailHTML(c: Case, f: Finding, i: number): string {
  const st = findingState(c, f);
  const lang = languageOf(f.file);
  const commit = c.commits.find(x => x.hash === f.commit);
  return `<article class="card finding-detail" id="d-${esc(f.id)}" hidden aria-label="${esc(f.title)}">
    <div class="detail-head"><div class="badges">${tierBadge(st)}${sevBadge(f.severity)}${lang ? `<span class="chip-lang">${esc(lang)}</span>` : ''}<span class="mono dim">${esc(f.file)}:${esc(f.lines)}</span>${f.ref ? `<span class="badge">${esc(f.ref)}</span>` : ''}<span class="badge">in ${esc(f.commit.slice(0, 7))}</span>${f.origin === 'claim' ? '<span class="badge badge-ai">Reviewer</span>' : ''}</div>
      <h3>${esc(f.title)}</h3>
      <div class="meaning">${f.observed.map(t => `<p><span class="tag tag-observed">Observed</span><span>${esc(t)}</span></p>`).join('')}${f.inferred.map(t => `<p><span class="tag tag-inferred">Inferred</span><span>${esc(t)}</span></p>`).join('')}</div>
      <div class="why"><span>Ranks #${i + 1} because:</span>${f.why.map(w => `<span class="badge">${esc(w)}</span>`).join('')}<span class="badge">risk ${f.risk}</span></div>
      ${commit ? `<p class="dim">${esc(commit.subject)} · ${esc(commit.author)} · ${esc(commit.date.slice(0, 10))}</p>` : ''}</div>
    <div class="tabbody">${diffHTML(f)}<div class="legend"><span><i></i>The marked line is the one this is about</span></div>
      <div class="evlist">${f.evidence.map(e => `<div class="ev"><div><div class="badges"><span class="badge badge-accent">${esc(e.kind)}</span><span class="dim">${esc(e.source)}</span></div><p class="ev-what">${esc(e.what)}</p>${e.kind === 'claim' ? '' : `<p class="ev-cmd"><code>assay replay ${esc(e.id)}</code></p>`}</div></div>`).join('')}</div></div></article>`;
}

function timelineHTML(commits: CommitSummary[]): string {
  const rows = [...commits].reverse().map(x => `<tr><td class="lane" aria-hidden="true"><span class="lane-dot"></span></td><td><span class="mono hash dim">${esc(x.short)}</span> <b>${esc(x.subject)}</b><br><span class="dim" style="font-size:var(--t-xs)">${esc(x.author)} · ${esc(x.date.slice(0, 10))} · ${esc(x.languages.join(', ') || '—')}</span></td>
    <td class="num">${x.files}</td><td class="num"><span style="color:var(--ok)">+${x.additions}</span> <span style="color:var(--danger)">−${x.deletions}</span></td>
    <td>${x.counts.proven ? `<span class="cell danger">${x.counts.proven} proven</span> ` : ''}${x.counts.corroborated ? `<span class="cell warn">${x.counts.corroborated} corroborated</span> ` : ''}${x.counts.hint ? `<span class="cell">${x.counts.hint} hint${x.counts.hint > 1 ? 's' : ''}</span>` : ''}${x.counts.proven + x.counts.corroborated + x.counts.hint ? '' : '<span class="cell none">—</span>'}</td>
    <td><div class="riskbar"><i class="${x.risk >= 75 ? 'danger' : x.risk >= 40 ? 'warn' : 'ok'}"><b style="width:${x.risk}%"></b></i><span>${x.risk}</span></div></td></tr>`).join('');
  return `<div class="card"><div class="table-wrap"><table class="table tl"><thead><tr><th></th><th>Commit</th><th>Files</th><th>Lines</th><th>Findings</th><th>Risk</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function shotsHTML(c: Case): string {
  const dir = assayPath('shots', c.id);
  const url = (name: string): string | null => { try { return `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, name)).toString('base64')}`; } catch { return null; } };
  const shots = c.runs.flatMap(r => r.shots ?? []).filter(s => s.changed >= 0.0001).sort((a, b) => b.changed - a.changed).slice(0, 4);
  const figs = shots.map(s => {
    const b = url(s.base), h = url(s.head), d = url(s.diff);
    if (!b || !h) return '';
    const [vp, scheme, dir] = s.combo.split('|');
    return `<figure class="shot card card-pad" style="margin:0"><figcaption><b>${esc(s.page)}</b> · ${esc(vp)}, ${esc(scheme)} scheme${dir === 'rtl' ? ', mirrored (right to left)' : ''} · ${(s.changed * 100).toFixed(2)}% of pixels changed</figcaption><div class="stack" style="--pos:50%"><img src="${h}" alt="After"><img class="b" src="${b}" alt="Before"><span class="rule"></span></div><input type="range" min="0" max="100" value="50" aria-label="Compare before and after"><div class="legend"><span>Left of the line: before (${esc(c.base?.slice(0, 7) ?? 'start')}). Right: after (${esc(c.head.slice(0, 7))}).</span></div>${d ? `<details><summary>Show what changed</summary><img src="${d}" alt="Changed pixels in orange"></details>` : ''}</figure>`;
  }).filter(Boolean);
  return figs.length ? `<h2 class="section-title">Before and after</h2><div class="shots">${figs.join('')}</div>` : '';
}

export function reportHTML(c: Case): string {
  const v = verdictOf(c);
  const tone = v.tone === 'blocked' ? 'danger' : v.tone === 'mergeable' ? 'warn' : 'ok';
  const icon = v.tone === 'blocked' ? ICON.stop : v.tone === 'mergeable' ? ICON.alert : ICON.shield;
  const open = c.findings.filter(f => isOpen(c, f));
  const done = c.findings.filter(f => !isOpen(c, f));
  const ordered = [...open, ...done];
  const secs = Math.round(c.commits.reduce((a, x) => a + x.secs, 0) * 10) / 10;
  let css = fs.readFileSync(path.join(assets, 'report.css'), 'utf8')
    .replace('__GEIST_MONO__', () => b64('geist-mono.woff2')).replace('__GEIST__', () => b64('geist.woff2')).replace('__SILKSCREEN__', () => b64('silkscreen.woff2'));
  css += EXTRA_CSS;
  const list = ordered.map((f, i) => `<button class="citem ${isOpen(c, f) ? '' : 'is-done'}" data-f="${esc(f.id)}" aria-pressed="false"><span class="rank">${i + 1}</span><span><span class="it-title">${esc(f.title)}</span><span class="it-meta">${tierBadge(findingState(c, f))} <span class="chip-lang">${esc(languageOf(f.file) ?? 'file')}</span><span class="mono">${esc(f.file.split('/').pop())}</span><span>risk ${f.risk}</span></span></span></button>`).join('');
  const range = `${c.base ? c.base.slice(0, 7) : 'the first commit'}..${c.head.slice(0, 7)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(c.name)} · assay case ${esc(c.id)}</title><style>${css}</style></head>
<body><div class="app report"><main class="main" id="main">
<div class="page page-wide">
  <div class="report-head"><div class="brand"><span class="brand-name">assay</span></div><span class="badge badge-accent">Case file</span><span class="dim mono">${esc(c.id)}</span></div>
  <div class="page-head"><div><h1 class="page-title">${esc(c.name)}</h1><p class="page-sub">${esc(range)} · ${c.commits.length} commit${c.commits.length > 1 ? 's' : ''} · ${c.files} files · ${esc(c.languages.join(', ') || 'no code')}</p></div></div>
  <section class="verdict ${tone}" aria-label="Verdict"><div class="verdict-icon">${icon}</div>
    <div><h2>${esc(v.headline)}</h2><p class="counts"><b>${v.must.length}</b> must fix · <b>${v.should.length}</b> should fix · <b>${v.decide.length}</b> to decide · <b>${v.hints.length}</b> hint${v.hints.length === 1 ? '' : 's'}</p></div><div></div>
    <div class="verdict-foot"><span>Free checks: <b>${secs} s, 0 tokens</b></span><span>${c.claims.length ? `Reviewer claims: <b>${c.claims.length}</b> (${c.dropped.length} dropped by the gate)` : 'Reviewers: <b>not run</b>'}</span>${c.skippedMerges ? `<span>${c.skippedMerges} merge commit${c.skippedMerges > 1 ? 's' : ''} left out</span>` : ''}<span>${c.runs.length ? `Proof: ${c.runs.map(r => esc(r.summary)).join(' · ')}` : 'Proof: <b>not run</b> (assay prove)'}</span></div></section>
  ${ordered.length ? `<div class="split"><div class="itemlist" role="list" aria-label="Significant changes, most important first">${list}</div><div>${ordered.map((f, i) => detailHTML(c, f, i)).join('')}</div></div>` : '<div class="card zero">Nothing significant in this range. The free checks found no risky pattern, secret, dependency change or untested logic.</div>'}
  ${shotsHTML(c)}
  <h2 class="section-title">Timeline</h2>${timelineHTML(c.commits)}
  ${c.dropped.length ? `<div class="card card-pad"><div class="card-title">Dropped by the evidence gate</div><ul class="dropped">${c.dropped.map(d => `<li><span class="badge">${esc(d.reason)}</span><span><s>${esc(d.claim.title)}</s> · ${esc(d.claim.file)}:${d.claim.line} · ${esc(d.claim.source)}</span></li>`).join('')}</ul></div>` : ''}
  <p class="foot">Generated by assay on ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC. A tier is computed from evidence: proven needs a reproducible fact; corroborated needs two independent signals; a hint is one signal and can’t block a merge.</p>
</div></main></div><script>${SCRIPT}</script></body></html>`;
}
