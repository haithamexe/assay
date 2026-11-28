import { ACT, S, render, sync } from './state.js';
import { api, html, ico, loading, plural, problem, short, sevBadge, timeAgo } from './lib.js';

/* Gremlins: the runs kept for this project, what each found with the steps that led to it, and how it compares with the run before.
   Reading is free. Starting a run is not done here: it clicks and types in a browser, so it needs a person's own
   `assay allow-run --writes` in a terminal, and this page shows the command (with Copy) instead of a button that runs it. */

export async function loadGremlins() {
  S.gr.data = await api('/api/gremlins');
  const ids = S.gr.data.runs.map(r => r.id);
  if (!S.gr.sel || !ids.includes(S.gr.sel)) S.gr.sel = ids[0] || null;
  await loadRun();
}

async function loadRun() {
  S.gr.run = null;
  S.gr.error = null;
  if (!S.gr.sel) return;
  try { S.gr.run = await api(`/api/gremlins/run?id=${encodeURIComponent(S.gr.sel)}`); } catch (e) { S.gr.error = e.message; }
}

const cmdline = cmd => html`<div class="cmdline"><code>${cmd}</code><button class="btn btn-sm" data-act="copycmd" data-cmd="${cmd}">${ico.copy} Copy</button></div>`;
const sinceBadge = s => (s === 'new' ? html`<span class="badge badge-warn">New</span>` : s === 'before' ? html`<span class="badge">There before</span>` : '');
const where = r => (r.mode === 'running' ? r.url : `a clean copy of ${short(r.commit)}${r.base ? ` against ${short(r.base)}` : ''}`);

function lock() {
  const d = S.gr.data;
  if (d.writes) return html`<div class="card card-pad stack-12"><div class="card-title">Run it</div><p class="dim limit-copy">Run it in a terminal, in this project. Give it an app that is already running, or a commit to start the app from:</p>${cmdline('assay gremlins --url http://localhost:3000')}${cmdline('assay gremlins --ref HEAD --base HEAD~1')}<p class="dim">The browser talks to this computer only, and leaves controls named delete or sign out alone.</p></div>`;
  return html`<div class="callout">${ico.lock}<div><b>Running gremlins needs your OK first.</b><br><span class="dim">They click and type, and a click can save and a typed text can be sent, so only a person can switch it on, in a terminal. Nothing in this dashboard, and nothing an agent can do, switches it on.</span>${d.allowed ? '' : html`<br><span class="dim">First, running this project’s app:</span>${cmdline(d.allowCommand)}`}<span class="dim">Then:</span>${cmdline(d.command)}</div></div>`;
}

function listHTML() {
  return html`${S.gr.data.runs.map(r => html`<button class="memrow" data-act="gr-sel" data-id="${r.id}" aria-pressed="${String(S.gr.sel === r.id)}"><span class="mono dim">${r.seed}</span><span><b>${r.mode === 'running' ? r.url : `Copy of ${short(r.commit)}`}</b><br><span class="dim sub">${timeAgo(r.createdAt)} · ${plural(r.actions, 'action')}${r.signedIn ? ' · signed in' : ''}${r.phone ? ' · phone' : ''}</span></span><span class="badge ${r.findings ? 'badge-danger' : 'badge-ok'}">${r.findings ? plural(r.findings, 'problem') : 'Clear'}${r.newCount ? ` · ${r.newCount} new` : ''}</span></button>`)}`;
}

function findingHTML(f) {
  return html`<div class="card card-pad stack-12"><div class="badges">${sevBadge(f.severity)}${sinceBadge(f.since)}<span class="badge">${f.kind}</span>${f.count > 1 ? html`<span class="badge">×${f.count}</span>` : ''}${f.where ? html`<span class="badge mono">${f.where}</span>` : ''}</div>
    <div><b>${f.title}</b><br><code class="wrap">${f.text}</code></div>
    <div><span class="dim">After these steps${f.steps.length < f.step ? html` (the last ${f.steps.length} of ${f.step})` : ''}:</span><ol class="steps">${f.stepsText.map(t => html`<li><code>${t}</code></li>`)}</ol></div>
    <p class="dim">${f.fix}</p>${cmdline(f.replayCommand)}</div>`;
}

function detailHTML() {
  const r = S.gr.run;
  if (S.gr.error) return html`<div class="callout" role="alert">${ico.alert}<div><b>That run couldn’t be read.</b><br><span class="dim">${S.gr.error}</span></div></div>`;
  if (!r) return html`<div class="card card-pad"><p class="dim">Nothing to show.</p></div>`;
  const fresh = r.findings.filter(f => f.since === 'new').length;
  return html`<article class="card"><div class="detail-head"><div class="badges"><span class="mono dim">${r.id}</span><span class="badge ${r.findings.length ? 'badge-danger' : 'badge-ok'}">${r.findings.length ? plural(r.findings.length, 'problem') : 'Nothing broke'}</span>${r.previous && r.findings.length ? html`<span class="badge ${fresh ? 'badge-warn' : ''}">${fresh} new</span>` : ''}${r.signedIn ? html`<span class="badge badge-accent">Signed in</span>` : ''}</div></div>
    <div class="tabbody stack-12"><div class="facts facts-wide"><div class="k">Where</div><div>${where(r)}</div><div class="k">Seed</div><div class="mono">${r.seed}</div><div class="k">Done</div><div>${r.actions} of ${r.planned} actions · ${r.phone ? 'as a phone' : 'on a desktop'} · ${r.secs} s · ${timeAgo(r.createdAt)}${r.stopped ? ` · stopped: ${r.stopped}` : ''}</div>
      <div class="k">Pages</div><div>${r.pages.length ? r.pages.map(p => html`<div class="mono">${p}</div>`) : html`<span class="dim">none</span>`}</div>
      ${r.previous ? html`<div class="k">Compared with</div><div><button class="linkbtn" data-act="gr-sel" data-id="${r.previous.id}">${r.previous.id}</button> <span class="dim">(seed ${r.previous.seed}${r.previous.seed === r.seed ? ', the same' : ', another: a problem that isn’t here now may only not have been reached'})</span></div>` : html`<div class="k">Compared with</div><div class="dim">nothing yet: this is the first run of this app</div>`}</div>
      ${r.findings.map(findingHTML)}
      ${r.findings.length ? '' : html`<div class="callout">${ico.check}<div><b>Nothing broke.</b> <span class="dim">A run is a sample, so this is not proof that nothing is wrong. Another seed goes elsewhere.</span></div></div>`}
      ${r.gone.length ? html`<div class="callout">${ico.check}<div><b>${plural(r.gone.length, 'problem')} gone since the last run</b>${r.gone.map(g => html`<br><span class="dim">${g.title}: <code class="wrap">${g.text}</code></span>`)}</div></div>` : ''}
      ${r.blocked.length ? html`<div class="callout">${ico.lock}<div><b>The browser refused to talk to ${r.blocked.join(', ')}.</b> <span class="dim">Those are not on this computer.</span></div></div>` : ''}
      ${r.skipped.length ? html`<p class="dim">Left alone because they look destructive: ${r.skipped.join(' · ')}</p>` : ''}
      ${r.notes.filter(n => !/^The browser refused/.test(n)).map(n => html`<p class="dim">${n}</p>`)}
      <div><span class="dim">Again with the same seed:</span>${cmdline(r.replayCommand)}</div></div></article>`;
}

export function pageGremlins() {
  if (S.error && !S.gr.data) return problem('Gremlins', S.error);
  if (!S.gr.data) return loading('Gremlins', 'Reading the runs…');
  const d = S.gr.data;
  return html`<div class="page page-wide"><div class="page-head"><div><h1 class="page-title">Gremlins</h1><p class="page-sub">A browser goes through the app clicking and typing nonsense, seeded, and keeps the steps behind each problem. Each run is compared with the one before.</p></div></div>
    ${lock()}
    ${d.runs.length ? html`<div class="mem"><div class="card"><div id="grlist">${listHTML()}</div></div>${detailHTML()}</div>` : html`<div class="zero">No runs kept yet.</div>`}</div>`;
}

ACT['gr-sel'] = async el => {
  S.gr.sel = el.dataset.id;
  sync();
  await loadRun();
  render();
};
