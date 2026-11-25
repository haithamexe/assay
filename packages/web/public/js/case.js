import { afterCompare, compareHTML, kindsOf, shotsFor } from './compare.js';
import { ACT, S, render, sync } from './state.js';
import { $, announce, api, copyText, html, ico, loading, morph, plural, problem, raw, runJob, secs, short, shake, put, sevBadge, tierBadge, timeAgo, riskBar } from './lib.js';
import { loadTimeline, selection } from './timeline.js';

/* The case file: the verdict, the findings most important first, and for each one the lines, the evidence and, where there are pictures, before and after. */

const TONE = { blocked: 'danger', mergeable: 'warn', clear: 'ok' };
const TONE_ICON = { blocked: ico.stop, mergeable: ico.alert, clear: ico.shield };
const DONE = new Set(['fixed', 'dismissed', 'intended']);
const busy = () => !!S.job && (S.job.state === 'queued' || S.job.state === 'running');

export async function loadCase() {
  S.loading.case = true;
  S.error = null;
  try {
    if (S.caseId) {
      if (!S.view || S.view.case.id !== S.caseId) S.view = await api(`/api/case?id=${encodeURIComponent(S.caseId)}`);
    } else {
      if (!S.timeline) await loadTimeline();
      const sel = selection();
      if (!sel.length) throw new Error('Pick the commits on the timeline first.');
      S.view = await api('/api/open', S.sel.mode === 'branch' ? { mode: 'branch' } : { mode: 'span', from: sel[sel.length - 1].hash, to: sel[0].hash });
      S.caseId = S.view.case.id;
    }
  } catch (e) {
    S.error = e.message;
    S.view = null;
  } finally { S.loading.case = false; }
  sync();
}

/* ---------------------------------------------------------------- the run panel: tests and pages */
const CHECK_NAMES = { prove: 'the project’s tests', look: 'the pages in a browser' };

function facts(rows) { return html`<div class="facts facts-wide">${rows.map(([k, v]) => html`<div class="k">${k}</div><div>${v}</div>`)}</div>`; }

function proveFacts(r) {
  if (!r) return [];
  if (!r.ran) return [['Result', r.reason || 'It did not run.']];
  const run = x => {
    if (!x) return 'not run';
    const verdict = x.exit === 0 ? (x.passed === 0 ? 'ran no tests (exit 0)' : 'passed') : 'failed';
    return `${verdict}${x.passed ? ` · ${plural(x.passed, 'test')} passed` : ''}${x.failed ? ` · ${x.failed} failed` : ''} · ${secs(x.secs)}${x.cached ? ' · kept from before' : ''}`;
  };
  const rows = [['Command', html`<code>${r.command}</code>`], ['At the base', run(r.base)], ['At the head', run(r.head)]];
  if (r.regressions.length) rows.push(['Now failing', r.regressions.slice(0, 5).join('; ')]);
  if (r.reverts.length) rows.push(['Reverting the change', `${r.reverts.filter(x => x.result === 'unnoticed').length} of ${r.reverts.length} tried: no test noticed`]);
  if (r.mutants.length) {
    const n = k => r.mutants.filter(m => m.result === k).length;
    rows.push(['Deliberate changes', `${n('killed')} caught by a test, ${n('survived')} not caught${n('invalid') ? `, ${n('invalid')} invalid` : ''}`]);
  }
  if (r.stopped) rows.push(['Stopped', r.stopped]);
  if (r.reason) rows.push(['Note', r.reason]);
  return rows;
}

function lookFacts(r) {
  if (!r) return [];
  if (!r.ran) return [['Result', r.reason || 'It did not run.']];
  const rows = [['Pages', r.pages.join(', ')], ['Browser', `${r.browser} · ${r.mode === 'dev' ? 'the project’s dev server' : 'plain files'} · ${r.combos} sizes, schemes and directions each`]];
  if (r.head) rows.push(['At the head', plural(r.head.problems, 'problem') + ` on ${plural(r.head.pages, 'page')}`]);
  if (r.base) rows.push(['At the base', plural(r.base.problems, 'problem') + ` on ${plural(r.base.pages, 'page')}`]);
  rows.push(['New at the head', `${plural(r.newProblems, 'problem')}${r.probeHits ? `, ${plural(r.probeHits, 'probe hit')}` : ''}${r.looksDifferent ? `, ${plural(r.looksDifferent, 'picture')} look different` : ''}`]);
  if (r.stopped) rows.push(['Stopped', r.stopped]);
  if (r.reason) rows.push(['Note', r.reason]);
  return rows;
}

function jobPanelHTML() {
  if (S.needsOk) {
    const cmd = `assay allow-run --repo "${S.repo.path}"`;
    return html`<div class="callout">${ico.lock}<div><b>Running ${CHECK_NAMES[S.needsOk]} needs your OK first.</b><br><span class="dim">It runs this project’s own code, so only a person can switch it on, in a terminal. Nothing here can do it for you.</span><div class="cmdline"><code>${cmd}</code><button class="btn btn-sm" data-act="copycmd" data-cmd="${cmd}">${ico.copy} Copy</button></div><span class="dim">Then press the button again.</span></div></div>`;
  }
  const j = S.job;
  if (!j || S.jobCase !== (S.view && S.view.case.id)) return html``;
  const name = CHECK_NAMES[j.kind] || j.label;
  if (j.state === 'queued' || j.state === 'running') {
    const t = j.startedAt ? secs((Date.now() - j.startedAt) / 1000) : 'waiting';
    return html`<div class="card card-pad job"><div class="section-head"><span class="card-title"><span class="spinner"></span> ${j.state === 'queued' ? 'Waiting to run' : 'Running'} ${name}</span><span class="toolbar"><span class="dim">${t}</span><button class="btn btn-sm" data-act="stop">${ico.stop} Stop</button></span></div>
      <ul class="bisect-log" aria-live="off">${(j.messages || []).slice(-6).map(m => html`<li>${m}</li>`)}</ul></div>`;
  }
  if (j.state === 'failed') return html`<div class="callout">${ico.alert}<div><b>It didn’t finish.</b><br><span class="dim">${j.error || 'Something went wrong.'}</span></div></div>`;
  const rep = S.jobResult && S.jobResult.report;
  const rows = j.kind === 'prove' ? proveFacts(rep) : lookFacts(rep);
  const took = j.startedAt && j.endedAt ? secs((j.endedAt - j.startedAt) / 1000) : '';
  return html`<div class="card card-pad job"><div class="section-head"><span class="card-title">${j.state === 'stopped' ? ico.stop : ico.check} ${j.state === 'stopped' ? 'Stopped' : 'Finished'}: ${name}</span><span class="dim">${took}</span></div>${facts(rows)}</div>`;
}

function paintJob() {
  const el = $('#jobpanel');
  if (el) put(el, jobPanelHTML());
  for (const b of document.querySelectorAll('[data-act="run"]')) b.disabled = busy();
}

ACT.run = async el => {
  const kind = el.dataset.v;
  if (!S.repo.allowed) { S.needsOk = kind; paintJob(); return; }
  if (busy()) return;
  S.needsOk = null;
  S.jobResult = null;
  const id = S.view.case.id;
  S.jobCase = id;
  try {
    const job = await runJob(`/api/${kind}`, { case: id }, j => { S.job = j; paintJob(); });
    S.job = job;
    if ((job.state === 'done' || job.state === 'stopped') && job.result) {
      S.jobResult = { report: job.result.report };
      if (job.result.case && S.view && S.view.case.id === id) S.view = { case: job.result.case, verdict: job.result.verdict, states: job.result.states, order: job.result.order };
    }
    announce(job.state === 'done' ? `Finished ${CHECK_NAMES[kind]}` : job.state === 'stopped' ? 'Stopped' : 'It did not finish');
  } catch (e) {
    S.job = { id: null, kind, label: kind, state: 'failed', error: e.message, messages: [] };
    if (e.data && e.data.code === 'not-allowed') { S.needsOk = kind; S.repo.allowed = false; }
  }
  render();
};

ACT.stop = el => morph(el, async () => { if (S.job && S.job.id) await api('/api/stop', { id: S.job.id }); return { ok: true, label: 'Stopping' }; }, { busy: 'Stopping…', hold: 300 });
ACT.copycmd = el => morph(el, async () => ({ ok: await copyText(el.dataset.cmd), label: 'Copied' }), { busy: 'Copying…', done: 'Copied' });

/* ---------------------------------------------------------------- the page */
function diffHTML(f) {
  const s = f.snippet;
  return html`<div class="diff-file"><div class="diff-file-head"><span class="mono">${f.file}</span></div>${s.header ? html`<div class="diff-hunk-head mono">${s.header}</div>` : ''}<div class="diff-grid" tabindex="0" aria-label="Changed lines">${s.rows.map(r => html`<div class="diff-row ${r.t === '-' ? 'del' : r.t === '+' ? 'add' : ''}${r.sig ? ' sig' : ''}"><span class="diff-no">${r.o ?? ''}</span><span class="diff-no r">${r.n ?? ''}</span><span class="diff-mark">${r.t === ' ' ? '' : r.t}</span><span class="diff-text">${r.text}</span></div>`)}</div></div>`;
}

function replayLine(id) {
  const r = S.replay[id];
  if (!r) return html``;
  return html`<p class="ev-result ${r.reproduced ? 'ok' : 'bad'}">${r.reproduced ? ico.check : ico.x}<span>${r.detail}${r.error ? html` <span class="dim">(It could not run.)</span>` : ''}</span></p>`;
}

function evidenceTab(D, f) {
  const runs = D.case.runs.filter(r => r.findingIds.includes(f.id) || r.signalIds.includes(f.id));
  return html`<div class="evlist">${f.evidence.map(ev => html`<div class="ev"><div><div class="badges"><span class="badge badge-accent">${ev.kind}</span><span class="dim">${ev.source}</span></div><p class="ev-what">${ev.what}</p>${ev.kind === 'claim' ? '' : html`<p class="ev-cmd"><code>assay replay ${ev.id}</code></p>`}<div id="evr-${ev.id}">${replayLine(ev.id)}</div></div>${ev.kind === 'claim' ? '' : html`<button class="btn btn-sm" data-act="repro" data-id="${ev.id}">${ico.play} Reproduce</button>`}</div>`)}</div>
    ${runs.map(r => html`<p class="dim">From a run (${timeAgo(r.at)}, ${secs(r.secs)}): ${r.summary}. <code>${r.command}</code></p>`)}
    <p class="dim">Every proven finding carries evidence you can run again. A reviewer’s reading can’t be run again, and can only ever be a hint.</p>`;
}

function strip(f) {
  if (f.origin === 'claim') return html`<div class="revstrip"><span class="badge badge-ai">Reviewer</span><span>${(f.evidence.find(e => e.kind === 'claim') || {}).source || 'A reviewer'} said this. A reading is a hint until something shows it.</span></div>`;
  if (f.origin === 'run') return html`<div class="revstrip"><span class="badge badge-accent">${ico.play} Run</span><span>Found by running the project’s own tests or pages, not by reading code.</span></div>`;
  return html`<div class="revstrip"><span class="badge">${ico.check} Free check</span><span>Found by reading the change. No model has looked at this.</span></div>`;
}

/** What memory knows about this kind of mistake: how often it was seen here and how often it was a false alarm. */
function memoryHTML(D, f) {
  const m = (D.memory && D.memory[f.id]) || [];
  return html`${m.map(e => html`<div class="callout">${ico.db}<div><b><a href="#/memory?id=${encodeURIComponent(e.id)}">${e.name}</a></b><br><span class="dim">${e.kind === 'learned' ? 'Learned here' : 'Standard'}. Seen ${plural(e.hits, 'time')} in this project, ${e.falseAlarms} dismissed as false alarms. ${e.detector}.</span></div></div>`)}`;
}

function detailHTML(D, f) {
  const c = D.case;
  const st = D.states[f.id];
  const shots = shotsFor(D, f);
  const tabs = [...(shots.length ? [['ba', 'Before / after']] : []), ['code', 'Code'], ['ev', 'Evidence']];
  const tab = tabs.some(t => t[0] === S.tab) ? S.tab : tabs[0][0];
  const commit = c.commits.find(x => x.hash === f.commit);
  const actions = st === 'dismissed' ? html`<span class="inline-note">${ico.check} Dismissed as a false positive. It no longer counts against the verdict.</span><button class="btn btn-sm btn-ghost" data-act="resolve" data-how="reopen" data-id="${f.id}">Undo</button>`
    : st === 'intended' ? html`<span class="inline-note">${ico.check} Marked as intended. It no longer counts against the verdict.</span><button class="btn btn-sm btn-ghost" data-act="resolve" data-how="reopen" data-id="${f.id}">Undo</button>`
      : st === 'fixed' ? html`<span class="inline-note">${ico.check} A later commit in this range already fixed it. It doesn’t count.</span>`
        : html`<button class="btn btn-sm" data-act="resolve" data-how="intended" data-id="${f.id}">Mark as intended</button><button class="btn btn-sm btn-ghost" data-act="resolve" data-how="dismissed" data-id="${f.id}">Dismiss as a false positive</button>${S.actionError && S.actionError.id === f.id ? html`<span class="inline-note bad">${ico.x} ${S.actionError.message}</span>` : ''}`;
  const body = tab === 'ba' ? compareHTML(c, shots, kindsOf(f)) : tab === 'code' ? html`${diffHTML(f)}<div class="legend"><span><i></i>The marked line is the one this is about</span><span>${f.snippet.rows.filter(r => r.t === '+').length} added · ${f.snippet.rows.filter(r => r.t === '-').length} removed</span></div>` : evidenceTab(D, f);
  return html`<article class="card" aria-label="${f.title}"><div class="detail-head"><div class="badges">${tierBadge(st)}${sevBadge(f.severity)}${f.lang ? html`<span class="chip-lang">${f.lang}</span>` : ''}<span class="mono dim">${f.file}:${f.lines}</span>${f.ref ? html`<span class="badge">${f.ref}</span>` : ''}<span class="badge">in ${short(f.commit)}</span></div>
      <h3>${f.title}</h3>
      <div class="meaning">${f.observed.map(t => html`<p><span class="tag tag-observed">Observed</span><span>${t}</span></p>`)}${f.inferred.map(t => html`<p><span class="tag tag-inferred">Inferred</span><span>${t}</span></p>`)}</div>
      <div class="why"><span>Ranks here because:</span>${f.why.map(w => html`<span class="badge">${w}</span>`)}<span class="badge">risk ${f.risk}</span></div>${strip(f)}${disputeHTML(D, f)}${memoryHTML(D, f)}
      ${commit ? html`<p class="dim">${commit.subject} · ${commit.author} · ${commit.date.slice(0, 10)}</p>` : ''}</div>
    <div class="detail-tabs"><div class="segmented" role="group" aria-label="Detail">${tabs.map(([k, l]) => html`<button data-act="tab" data-v="${k}" aria-pressed="${String(tab === k)}">${l}</button>`)}</div></div>
    <div class="tabbody">${body}</div><div class="detail-actions">${actions}</div></article>`;
}

/** Where the reviewer panel stands for this case, in a few words, with a way to the Reviewers screen. */
function reviewersLine(c) {
  const p = c.panel;
  if (!p) return html`Reviewers: <b>not planned</b> <a href="#/reviewers?id=${encodeURIComponent(c.id)}">See the cost</a>`;
  const run = p.reviewers.filter(r => r.run);
  if (!run.length) return html`Reviewers: <b>none worth running</b> <a href="#/reviewers?id=${encodeURIComponent(c.id)}">Why</a>`;
  const done = run.filter(r => r.state === 'reported').length;
  return html`Reviewers: <b>${done} of ${run.length} reported</b> <a href="#/reviewers?id=${encodeURIComponent(c.id)}">Open</a>`;
}

/** A reviewer who doubted another reviewer's claim says so under the finding. It changes no tier. */
function disputeHTML(D, f) {
  const ds = ((D.case.panel && D.case.panel.cross.disputes) || []).filter(d => d.finding === f.id);
  return html`${ds.map(d => html`<div class="callout callout-ai">${ico.users}<div><b>Disputed by the ${d.by} reviewer.</b><br><span class="dim">${d.reason} A dispute changes no tier: what one reviewer says alone stays a hint.</span></div></div>`)}`;
}

export function pageCase() {
  if (!S.view && !S.error) return loading('Case file', 'Reading the commits and running the free checks…');
  if (!S.view) return problem('Case file', S.error || 'There is no case open.', html`<a class="btn btn-sm right" href="#/timeline">Pick the commits</a>`);
  const D = S.view;
  const c = D.case;
  const v = D.verdict;
  const byId = new Map(c.findings.map(f => [f.id, f]));
  const ordered = D.order.map(id => byId.get(id)).filter(Boolean);
  const lenses = [...new Set(ordered.map(f => f.lens))];
  if (S.lens !== 'all' && !lenses.includes(S.lens)) S.lens = 'all';
  const shown = ordered.filter(f => S.lens === 'all' || f.lens === S.lens);
  const folded = !S.showAll && shown.length > 5;
  const list = folded ? shown.slice(0, 5) : shown;
  const cur = byId.get(S.item) && shown.includes(byId.get(S.item)) ? byId.get(S.item) : shown[0];
  S.item = cur ? cur.id : null;
  const secsFree = Math.round(c.commits.reduce((a, x) => a + x.secs, 0) * 10) / 10;
  const range = `${c.base ? short(c.base) : 'the first commit'}..${short(c.head)}`;
  const files = c.files;
  const hasBrief = v.must.length + v.should.length + v.decide.length > 0;
  const lock = S.repo.allowed ? html`` : html`${ico.lock}`;
  const proofLine = c.runs.length ? html`Proof: ${c.runs.map(r => r.summary).join(' · ')}` : html`Proof: <b>not run</b>`;

  const verdictCard = html`<section class="verdict ${TONE[v.tone]}" aria-label="Verdict"><div class="verdict-icon">${TONE_ICON[v.tone]}</div>
    <div><h2>${v.headline}</h2><p class="counts"><b>${v.must.length}</b> must fix · <b>${v.should.length}</b> should fix · <b>${v.decide.length}</b> to decide · <b>${v.hints.length}</b> hint${v.hints.length === 1 ? '' : 's'}</p></div>
    <div class="toolbar">${hasBrief ? html`<button class="btn ${v.must.length || v.should.length ? 'btn-primary' : ''}" data-act="brief">${ico.copy} Hand to the agent</button>` : ''}
      <button class="btn" data-act="run" data-v="prove" ${busy() ? 'disabled' : ''} title="Runs the project’s own tests at the base and at the head">${lock.s ? lock : ico.play} Run the tests</button>
      <button class="btn" data-act="run" data-v="look" ${busy() ? 'disabled' : ''} title="Opens the pages in a browser at the base and at the head">${lock.s ? lock : ico.eye} Look at the pages</button></div>
    <div class="verdict-foot"><span>Free checks: <b>${secsFree} s, 0 tokens</b></span><span>${proofLine}</span><span>${reviewersLine(c)}</span>${c.claims.length ? html`<span>Reviewer claims: <b>${c.claims.length}</b> (${c.dropped.length} dropped by the gate)</span>` : ''}${c.skippedMerges ? html`<span>${plural(c.skippedMerges, 'merge commit')} left out</span>` : ''}</div></section>`;

  const facets = lenses.length > 1 ? html`<div class="facets" role="group" aria-label="Filter by lens"><button class="btn btn-sm ${S.lens === 'all' ? '' : 'btn-ghost'}" data-act="lens" data-v="all" aria-pressed="${String(S.lens === 'all')}">All <span class="n">${ordered.length}</span></button>${lenses.map(l => html`<button class="btn btn-sm ${S.lens === l ? '' : 'btn-ghost'}" data-act="lens" data-v="${l}" aria-pressed="${String(S.lens === l)}">${l} <span class="n">${ordered.filter(f => f.lens === l).length}</span></button>`)}</div>` : '';

  const listHTML = list.map((f, k) => {
    const st = D.states[f.id];
    return html`<button class="citem ${DONE.has(st) ? 'is-done' : ''}" data-act="sel" data-id="${f.id}" aria-pressed="${String(cur && f.id === cur.id)}"><span class="rank">${k + 1}</span><span><span class="it-title">${f.title}</span><span class="it-meta">${tierBadge(st)} ${f.lang ? html`<span class="chip-lang">${f.lang}</span>` : ''}<span class="mono">${f.file.split('/').pop()}</span><span>risk ${f.risk}</span></span></span></button>`;
  });

  const body = ordered.length
    ? html`<div class="split"><div class="itemlist" role="list" aria-label="Significant changes, most important first">${listHTML}${folded ? html`<button class="btn btn-ghost" data-act="showAll">Show all ${shown.length}</button>` : ''}</div>${cur ? detailHTML(D, cur) : ''}</div>`
    : html`<div class="card zero">Nothing significant in this range. The free checks found no risky pattern, secret, dependency change or untested logic.</div>`;

  return html`<div class="page page-wide">
    <div class="page-head"><div><h1 class="page-title">${c.commits.length === 1 ? c.commits[0].subject : `${c.name} · ${range}`}</h1><p class="page-sub">${c.commits.length === 1 ? `${short(c.head)} · ` : ''}${plural(c.commits.length, 'commit')} · ${plural(files, 'file')} · ${c.languages.join(', ') || 'no code'}</p></div>
      <div class="toolbar"><a class="btn" href="#/timeline">${ico.clock} Change the commits</a></div></div>
    ${verdictCard}<div id="jobpanel">${jobPanelHTML()}</div>${facets}${body}
    ${c.dropped.length ? html`<div class="card card-pad stack-12"><div class="card-title">Dropped by the evidence gate</div><ul class="dropped">${c.dropped.map(d => html`<li><span class="badge">${d.reason}</span><span><s>${d.claim.title}</s> · ${d.claim.file}:${d.claim.line} · ${d.claim.source}</span></li>`)}</ul></div>` : ''}
    <details class="card commits"><summary>Commits in this case (${c.commits.length})</summary><div class="table-wrap"><table class="table"><thead><tr><th>Commit</th><th class="num">Files</th><th>Risk</th></tr></thead><tbody>${[...c.commits].map(x => html`<tr><td><span class="mono hash dim">${x.short}</span> <b>${x.subject}</b><br><span class="dim c-meta">${x.author} · ${x.date.slice(0, 10)}</span></td><td class="num">${x.files}</td><td>${riskBar(x.risk)}</td></tr>`)}</tbody></table></div></details></div>`;
}

export function afterCase() { afterCompare(); }

ACT.lens = el => { S.lens = el.dataset.v; sync(); render(); };
ACT.showAll = () => { S.showAll = true; render(); };
ACT.sel = el => { S.item = el.dataset.id; S.tab = null; S.cmp.shot = -1; sync(); render(); };
ACT.tab = el => { S.tab = el.dataset.v; sync(); render(); };

ACT.resolve = async el => {
  const id = el.dataset.id;
  try {
    S.actionError = null;
    S.view = await api('/api/resolve', { case: S.view.case.id, finding: id, how: el.dataset.how });
    announce(el.dataset.how === 'reopen' ? 'Reopened' : el.dataset.how === 'dismissed' ? 'Dismissed' : 'Marked as intended');
  } catch (e) {
    S.actionError = { id, message: e.message };
    announce(e.message);
    shake(el);
  }
  render();
};

ACT.repro = el => {
  const id = el.dataset.id;
  const paint = () => { const t = $(`#evr-${CSS.escape(id)}`); if (t) put(t, replayLine(id)); };
  return morph(el, async () => {
    try {
      const job = await runJob('/api/replay', { case: S.view.case.id, evidence: id });
      const r = job.result;
      if (job.state !== 'done' || !r) { S.replay[id] = { reproduced: false, detail: job.error || 'It did not finish.', error: true }; paint(); return { ok: false, label: 'Failed' }; }
      S.replay[id] = { reproduced: r.reproduced, detail: r.detail };
      paint();
      return { ok: r.reproduced, label: r.reproduced ? 'Reproduced' : 'Not reproduced' };
    } catch (e) {
      S.replay[id] = { reproduced: false, detail: e.message, error: true };
      paint();
      return { ok: false, label: 'Failed' };
    }
  }, { busy: 'Replaying…', hold: 1500 });
};

ACT.brief = async () => {
  try {
    const b = await api(`/api/brief?case=${encodeURIComponent(S.view.case.id)}`);
    $('#brieftext').value = b.text;
    $('#briefmeta').textContent = `${b.words} words, roughly ${b.tokens} tokens. Evidence is replayed by id, not pasted.`;
    $('#brief').showModal();
  } catch (e) { announce(e.message); }
};
ACT.copybrief = el => morph(el, async () => ({ ok: await copyText($('#brieftext').value), label: 'Copied' }), { busy: 'Copying…', done: 'Copied' });
ACT.closebrief = () => $('#brief').close();

export { raw };
