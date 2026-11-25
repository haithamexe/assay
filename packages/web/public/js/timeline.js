import { ACT, S, go, sync, render } from './state.js';
import { api, cell, html, ico, loading, problem, raw, riskBar, short, timeAgo } from './lib.js';

/* The timeline: what the free checks found on each recent commit, and a way to pick the commits a case is about. */

const rows = () => S.timeline || [];
const idx = h => rows().findIndex(r => r.hash === h);

/** The commits the current selection covers, newest first. */
export function selection() {
  const rs = rows();
  if (S.sel.mode === 'branch') { const set = new Set(S.branch ? S.branch.hashes : []); return rs.filter(r => set.has(r.hash)); }
  const a = idx(S.sel.from), b = idx(S.sel.to);
  if (a < 0 || b < 0) return [];
  return rs.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function defaultSelection() {
  const rs = rows();
  if (!rs.length) return;
  const known = h => h && idx(h) >= 0;
  if (S.sel.mode !== 'branch' && (!known(S.sel.from) || !known(S.sel.to))) S.sel.from = S.sel.to = rs[0].hash;
}

let inflight = null;
/** One read at a time: asking again while it is still reading waits for the same answer. */
export function loadTimeline() {
  if (!inflight) inflight = readTimeline().finally(() => { inflight = null; });
  return inflight;
}

async function readTimeline() {
  S.loading.timeline = true;
  try {
    const [t, cases] = await Promise.all([api(`/api/timeline?limit=${S.limit}`), api('/api/cases').catch(() => [])]);
    S.timeline = t.rows;
    S.branch = t.branch;
    S.cases = cases;
    S.newCommits = false;
    S.error = null;
    defaultSelection();
  } finally { S.loading.timeline = false; }
}

function baselineOf() {
  const sel = selection();
  if (!sel.length) return null;
  return S.sel.mode === 'branch' ? S.branch && S.branch.base : sel[sel.length - 1].parent;
}

function findingsCell(r) {
  const c = r.counts;
  const total = c.proven + c.corroborated + c.hint;
  if (!total) return cell('none', '—');
  return html`${c.proven ? cell('danger', `${c.proven} proven`, 'Findings with proof') : ''} ${c.corroborated ? cell('warn', `${c.corroborated} corroborated`, 'Two independent signals agree') : ''} ${c.hint ? cell('', `${c.hint} hint${c.hint > 1 ? 's' : ''}`, 'One signal: look, don’t obey') : ''}${r.lenses && r.lenses.length ? html` <span class="dim c-lenses">${r.lenses.join(' · ')}</span>` : ''}`;
}

export function pageTimeline() {
  if (S.error && !S.timeline) return problem('Timeline', S.error, html`<button class="btn btn-sm right" data-act="refresh">Try again</button>`);
  if (!S.timeline) return loading('Timeline', 'Reading the commits…');
  const rs = rows();
  const sel = selection();
  const inSel = new Set(sel.map(r => r.hash));
  const mode = S.sel.mode;
  const base = baselineOf();
  const hint = mode === 'branch'
    ? (S.branch && S.branch.fallback ? 'No main branch was found, so the last five commits stand in for the branch.' : 'The whole branch is selected.')
    : mode === 'single' ? 'Click a commit.' : S.sel.pick ? 'Now click the other end of the range.' : 'Click a commit, then another.';
  const asc = [...rs].reverse();

  const body = rs.map(r => {
    const on = inSel.has(r.hash);
    return html`<tr class="crow ${on ? 'in-range' : ''} ${base && r.hash === base ? 'is-base' : ''}">
      <td class="lane" aria-hidden="true"><span class="lane-dot"></span></td>
      <td><button class="commit-btn" data-act="pick" data-h="${r.hash}" aria-pressed="${String(on)}" ${mode === 'branch' ? 'disabled' : ''}><span class="mono hash">${r.short}</span><span class="c-msg">${r.subject}</span><span class="dim c-meta">${r.author} · ${timeAgo(r.date)} · ${r.languages.join(', ') || 'no code'}${base && r.hash === base ? ' · baseline' : ''}</span></button></td>
      <td class="num">${r.files}</td>
      <td class="num"><span class="add-n">+${r.additions}</span> <span class="del-n">−${r.deletions}</span></td>
      <td>${findingsCell(r)}</td>
      <td>${riskBar(r.risk)}</td></tr>`;
  });

  const strip = asc.map(r => {
    const on = inSel.has(r.hash);
    const t = r.risk >= 75 ? 'danger' : r.risk >= 40 ? 'warn' : 'ok';
    return html`<button data-act="pick" data-h="${r.hash}" aria-pressed="${String(on)}" aria-label="${r.short}, risk ${r.risk}" title="${r.short} · risk ${r.risk}" ${mode === 'branch' ? 'disabled' : ''}><span class="bar ${t}" data-css="height:${Math.max(6, Math.round(r.risk * 0.7))}px"></span></button>`;
  });

  const kept = S.cases && S.cases.length ? html`<div class="card"><div class="card-head"><span class="card-title">Cases kept for this project</span><span class="dim">Reopening one is instant, and keeps what was run.</span></div>
    ${S.cases.map(k => html`<div class="keptrow"><span class="dot-tone ${k.verdict.tone}" title="${k.verdict.headline}"></span><span class="kept-main"><b>${k.subject || 'Case'}</b><br><span class="dim">${k.base ? short(k.base) : 'start'}..${short(k.head)} · ${k.commits} commit${k.commits > 1 ? 's' : ''} · ${k.findings} finding${k.findings === 1 ? '' : 's'} · ${k.verdict.headline} · ${timeAgo(k.createdAt)}</span></span><a class="btn btn-sm" href="#/case?id=${k.id}">Open</a></div>`)}</div>` : '';

  return html`<div class="page">
    <div class="page-head"><div><h1 class="page-title">Timeline</h1><p class="page-sub">${S.repo.name} · ${S.repo.branch}. The free checks ran on every commit and are kept by hash, so picking again is instant.</p></div>
      <div class="toolbar"><div class="segmented" role="group" aria-label="What to review">
        ${[['single', 'One commit'], ['range', 'Range'], ['branch', 'Whole branch']].map(([v, l]) => html`<button data-act="mode" data-v="${v}" aria-pressed="${String(mode === v)}">${l}</button>`)}</div>
        <button class="btn btn-primary" data-act="openCase" ${sel.length ? '' : 'disabled'}>Open case file ${ico.file}</button></div></div>
    ${S.newCommits ? html`<div class="callout">${ico.branch}<div><b>New commits arrived.</b> The list below is from when you opened this page.</div><button class="btn btn-sm right" data-act="refresh">Refresh</button></div>` : ''}
    <div class="inline-note">${ico.branch}<span>${sel.length ? html`<b>${sel.length}</b> commit${sel.length > 1 ? 's' : ''} · ${sel[sel.length - 1].short} → ${sel[0].short}${base ? html` · compared with ${short(base)}` : ' · from the first commit'} · ` : ''}${hint}</span></div>
    <div class="card"><div class="riskstrip" role="group" aria-label="Risk by commit, oldest to newest">${strip}</div><div class="riskaxis">${asc.map(r => html`<span>${r.short}</span>`)}</div>
      <div class="table-wrap"><table class="table tl"><thead><tr><th></th><th>Commit</th><th class="num">Files</th><th class="num">Lines</th><th title="What the free checks found">Findings</th><th>Risk</th></tr></thead><tbody>${body}</tbody></table></div>
      ${rs.length >= S.limit && S.limit < 200 ? html`<div class="card-pad"><button class="btn btn-ghost" data-act="more">Show ${Math.min(30, 200 - S.limit)} more commits</button></div>` : ''}</div>
    ${kept}</div>`;
}

ACT.pick = el => {
  const h = el.dataset.h;
  if (S.sel.mode === 'branch') S.sel.mode = 'single';
  if (S.sel.mode === 'single') { S.sel.from = S.sel.to = h; S.sel.pick = null; }
  else if (!S.sel.pick) { S.sel.pick = h; S.sel.from = S.sel.to = h; }
  else { S.sel.from = S.sel.pick; S.sel.to = h; S.sel.pick = null; }
  sync();
  render();
};

ACT.mode = el => {
  const m = el.dataset.v;
  const rs = rows();
  const was = S.sel.mode;
  if (m === 'single') { S.sel.from = S.sel.to = was === 'branch' ? (rs[0] && rs[0].hash) : S.sel.to; }
  else if (m === 'range' && was === 'branch' && S.branch && S.branch.hashes.length) {
    const inList = S.branch.hashes.filter(h => idx(h) >= 0);
    S.sel.from = inList[inList.length - 1];
    S.sel.to = inList[0];
  }
  S.sel.mode = m;
  S.sel.pick = null;
  defaultSelection();
  sync();
  render();
};

/** A new case is opened from what is selected: the case page does it when it has no case yet. */
ACT.openCase = () => { S.caseId = null; S.view = null; S.item = null; S.jobResult = null; S.replay = {}; go('case'); };

ACT.more = async () => { S.limit = Math.min(200, S.limit + 30); await loadTimeline(); render(); };
ACT.refresh = async () => {
  try { S.repo = await api('/api/state'); await loadTimeline(); } catch (e) { S.error = e.message; }
  render();
};

export { raw };
