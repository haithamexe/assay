import { ACT, S, parseHash, render, sync } from './state.js';
import { api, html, ico, loading, morph, plural, problem, runJob } from './lib.js';

/* Reviewers: who is worth their tokens for this case, what it costs, and how far the panel has got. Assay never calls a model. The panel is
   run by the person's own agent, from the prompt on this screen; this screen plans it, shows the cost first, and watches what comes back. */

const k = n => (n >= 1000 ? `${Math.round(n / 100) / 10}k`.replace(/\.0k$/, 'k') : String(n));

let timer = null;
const stopPoll = () => { if (timer) { clearInterval(timer); timer = null; } };
const livePhase = d => !!d && d.kept && ['waiting', 'reviewing', 'cross'].includes(d.status.phase);

export async function loadReviewers() {
  S.rv.error = null;
  try {
    if (!S.caseId) { S.view = await api('/api/open', { mode: 'branch' }); S.caseId = S.view.case.id; }
    S.rv.data = await api(`/api/panel?case=${encodeURIComponent(S.caseId)}`);
    S.view = null; // the case now carries a panel: the case file reads it again when it is opened
    if (S.rv.request === '' && S.rv.data.panel.request) S.rv.request = S.rv.data.panel.request;
    S.rv.cal = await api('/api/calibration');
    S.rv.calError = null;
  } catch (e) {
    S.rv.error = e.message;
    S.rv.data = null;
  }
  stopPoll();
  if (livePhase(S.rv.data) || calLive()) timer = setInterval(tick, 2500);
  sync();
}

async function tick() {
  if (parseHash().page !== 'reviewers') { stopPoll(); return; }
  if (document.hidden) return;
  try {
    S.rv.data = await api(`/api/panel?case=${encodeURIComponent(S.caseId)}`);
    if (S.rv.tab === 'score' || calLive()) S.rv.cal = await api('/api/calibration');
    S.view = null;
    // never rebuild the page under someone who is typing the request
    if (document.activeElement && document.activeElement.id === 'rvreq') return;
    render();
    if (!livePhase(S.rv.data) && !calLive()) stopPoll();
  } catch { /* the next tick tries again */ }
}

/** A calibration run is waiting for reviewers to report: the scoreboard moves as they do. */
const calLive = () => !!(S.rv.cal && S.rv.tab === 'score' && ((S.rv.cal.board && !S.rv.cal.board.complete) || (S.rv.cal.past && S.rv.cal.past.board && !S.rv.cal.past.board.complete)));

const BADGE = {
  off: ['Off', ''], budget: ['Over budget', ''], 'not-needed': ['Not needed', ''], 'no-request': ['No request', ''], calibration: ['Left out', 'badge-warn']
};

function badge(r, kept) {
  if (!r.run) { const [l, c] = BADGE[r.skip] || ['Not run', '']; return html`<span class="badge ${c}">${l}</span>`; }
  if (!kept) return html`<span class="badge badge-accent">Will run</span>`;
  if (r.state === 'reported') return html`<span class="badge badge-ok">${ico.check}Reported</span>`;
  if (r.state === 'briefed') return html`<span class="badge badge-ai"><span class="dot dot-pulse"></span>Working</span>`;
  return html`<span class="badge">Waiting</span>`;
}

function steps(d) {
  const p = d.panel;
  const tri = p.reviewers.find(r => r.lens === 'Scope');
  const spec = p.reviewers.filter(r => r.lens !== 'Scope' && r.run);
  const of = r => (!d.kept ? 'pending' : r.state === 'reported' ? 'done' : r.state === 'briefed' ? 'running' : 'pending');
  const specState = !spec.length ? 'skipped' : !d.kept ? 'pending' : spec.every(r => r.state === 'reported') ? 'done' : spec.some(r => r.state !== 'planned') ? 'running' : 'pending';
  const crossState = !p.cross.run ? 'skipped' : p.cross.state === 'done' ? 'done' : p.cross.state === 'open' ? 'running' : 'pending';
  // The attack pass (one more blind reviewer, outside the lenses) shares the step with cross-exam, as in the demo.
  const atk = p.attack && p.attack.run ? p.attack : null;
  const atkState = !atk ? 'skipped' : !d.kept ? 'pending' : atk.state === 'reported' ? 'done' : atk.state === 'briefed' ? 'running' : 'pending';
  const both = [crossState, atkState].filter(s => s !== 'skipped');
  const crossStep = !both.length ? 'skipped' : both.every(s => s === 'done') ? 'done' : both.includes('running') ? 'running' : 'pending';
  const gated = d.kept && (p.reviewers.some(r => r.claims > 0) || (atk && atk.claims > 0));
  return [
    ['Free checks', '0 tokens', 'done'],
    ['Triage', tri.run ? `~${k(tri.tokens)}` : 'off', tri.run ? of(tri) : 'skipped'],
    ['Reviewers', `${spec.length} of 6 · blind`, specState],
    [atk ? 'Cross-exam + attack' : 'Cross-exam', p.cross.run || atk ? `~${k((p.cross.run ? p.cross.tokens : 0) + (atk ? atk.tokens : 0))}` : 'skipped', crossStep],
    ['Evidence gate', 'no proof, no vote', gated ? 'done' : 'pending'],
    ['Verdict', 'proven blocks', d.kept && d.status.phase === 'done' ? 'done' : 'pending']
  ];
}

function cardHTML(r, kept) {
  const cls = kept && r.run && r.state === 'briefed' ? 'running' : !r.run ? 'skipped' : '';
  const foot = !r.run ? '0 tokens' : r.reportedTokens ? `${k(r.reportedTokens)} tokens reported` : `~${k(r.tokens)} tokens`;
  const found = kept && r.run && r.state === 'reported' ? `${r.kept + r.merged} of ${plural(r.claims, 'claim')} kept` : '';
  return html`<div class="rcard ${cls}"><div class="rtop"><span class="rname">${r.name}</span><span class="right">${badge(r, kept)}</span></div><p class="why-line">${r.why}</p><p class="blind">${ico.lock} Blind: can’t see the others until cross-exam</p><div class="rfoot"><span>${foot}</span><span>${found}</span></div></div>`;
}

function meterHTML(d) {
  const p = d.panel;
  const tri = p.reviewers.filter(r => r.lens === 'Scope').reduce((n, r) => n + r.tokens, 0);
  const spec = p.estimate.specialists - tri;
  const atkTokens = p.attack && p.attack.run ? p.attack.tokens : 0;
  const cap = Math.max(d.budget, p.estimate.total, 1);
  const seg = (v, c) => (v > 0 ? html`<i class="${c}" data-css="width:${Math.min(100, (v / cap) * 100)}%"></i>` : '');
  const saved = p.estimate.saved;
  const added = d.reviewerFindings;
  const per = added ? k(Math.round((d.tokensReported || p.estimate.specialists) / added)) : '—';
  return html`<div class="card card-pad meter"><div class="section-head"><span class="card-title">Tokens ${d.tokensReported ? '' : html`<span class="dim">(estimate)</span>`}</span><span class="dim">${k(p.estimate.total)} of ${d.budget ? `${k(d.budget)} budget` : 'a free-only budget'}</span></div>
    <div class="meterbar" role="img" aria-label="${k(p.estimate.total)} tokens of ${k(d.budget)}">${seg(tri, 't1')}${seg(spec, 't2')}${seg(p.cross.run ? p.cross.tokens : 0, 'tc')}${seg(atkTokens, 't3')}</div>
    <div class="meterlegend"><span class="l1">Triage ${k(tri)}</span><span class="l2">Reviewers ${k(spec)}</span><span class="lc">Cross-exam ${k(p.cross.run ? p.cross.tokens : 0)}</span>${atkTokens ? html`<span class="l3">Attack ${k(atkTokens)}</span>` : ''}</div>
    <div class="bignums"><div class="bignum"><b>${d.freeProven} of ${d.freeTotal}</b><span>findings the free checks already proved, at 0 tokens</span></div><div class="bignum"><b>~${k(saved)}</b><span>tokens not spent: lenses this change doesn’t touch</span></div><div class="bignum"><b>${per}</b><span>tokens per reviewer-added finding</span></div></div>
    <p class="dim">Counted by characters, so roughly: about four characters to a token. The agent can report what it really used.</p></div>`;
}

function gateHTML(d) {
  const p = d.panel;
  const atk = p.attack && p.attack.run ? p.attack : null;
  const any = d.kept && (d.claims > 0 || p.reviewers.some(r => r.state === 'reported') || (atk && atk.state === 'reported'));
  if (!any && !p.cross.run && !atk) return '';
  const keptN = p.reviewers.reduce((n, r) => n + r.kept + r.merged, 0) + (atk ? atk.kept + atk.merged : 0);
  const atkLine = !atk ? '' : atk.state === 'reported' ? `The attack pass tried to break the change: ${plural(atk.claims, 'claim')}, ${atk.kept + atk.merged} kept.` : atk.state === 'briefed' ? 'The attack pass is working on it.' : 'The attack pass is waiting to start.';
  const cross = d.cross;
  const crossLine = !p.cross.run ? 'Fewer than two reviewers are planned, so there is nobody to cross-examine.'
    : cross.state === 'done' ? `Cross-examination is done: ${plural(cross.confirmed, 'claim')} confirmed by a second reviewer, ${plural(d.disputes.length, 'dispute')} raised.`
      : cross.state === 'open' ? `Cross-examination is open: ${Object.keys(cross.assigned).filter(l => !cross.reported.includes(l)).join(', ') || 'nobody'} still to examine.`
        : 'Cross-examination opens when every reviewer has reported.';
  return html`<div class="card card-pad stack-12"><div class="card-title">Cross-exam and the evidence gate</div>
    ${any ? html`<p><b>${d.claims}</b> claims came in. <b>${keptN}</b> cited a line in the change and are kept. <b>${d.dropped.length}</b> ${d.dropped.length === 1 ? 'was' : 'were'} dropped for citing none${d.dropped.length ? ':' : '.'}</p>` : html`<p class="dim">Nothing has come back yet.</p>`}
    ${d.dropped.length ? html`<ul class="dropped">${d.dropped.map(x => html`<li>${ico.x}<span><s>${x.title}</s> · ${x.by}: ${x.why}</span></li>`)}</ul>` : ''}
    ${atkLine ? html`<p class="dim">${atkLine}</p>` : ''}
    <p class="dim">${crossLine}</p>
    ${d.disputes.length ? html`<div class="callout callout-ai">${ico.users}<div><b>Disputed.</b>${d.disputes.map(x => html`<br>${x.title}: ${x.by} says ${x.reason}`)} <span class="dim">A dispute changes no tier: what a reviewer alone says stays a hint.</span></div></div>` : ''}
    <div class="toolbar"><a class="btn btn-primary" href="#/case?id=${encodeURIComponent(d.caseId)}">${ico.file} Back to the case file</a></div></div>`;
}

/* ---------------------------------------------------------------- the scoreboard: does each reviewer earn its tokens? */
const MARK = { C: ['✓', 'C', 'Caught, with proof'], h: ['~', 'h', 'Flagged, no proof'], m: ['✗', 'm', 'Missed'], '-': ['·', 'na', 'Not this reviewer’s lens'], n: ['?', 'na', 'Not run'] };
const SHORT = { free: 'Free', plain: 'Plain', Security: 'Sec', Correctness: 'Cor', UI: 'UI', Tests: 'Tests', 'Supply chain': 'Supply', Performance: 'Perf' };
const COLS = ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Performance'];
const mark = c => { const [g, cls, tip] = MARK[c] || MARK.n; return html`<span class="${cls}" title="${tip}">${g}</span>`; };

/* ---------------------------------------------------------------- real bugs from the project's own history (read only: starting one is a command) */
function pastHTML(p) {
  if (!p) return '';
  if (!p.board) {
    return html`<div class="card card-pad stack-12"><div class="card-title">From your own history</div>
      <p class="dim limit-copy">The planted bugs are invented. Your own fix commits are real: a line a fix removed came in with an earlier commit. Assay can open each of those commits as a case, score the free checks on it at once, and have your agent run the reviewers, the attack pass and one plain review on it, scored on whether they flagged the line the fix later removed. It reads git and changes nothing, so it is a command: <code>${p.command}</code>.</p>
      ${p.problem ? html`<p class="dim">${p.problem}</p>` : ''}</div>`;
  }
  const b = p.board;
  const rows = b.rows.map(r => html`<tr><td><b>${r.name}</b></td><td class="num">${r.caught}</td><td class="num">${r.flagged}</td><td class="num">${r.missed}</td><td class="num">${r.id === 'free' ? '0' : r.perCatch !== null ? html`${k(r.perCatch)}${r.tokensKind === 'estimate' ? '~' : ''}` : '—'}</td><td class="dim">${r.advice}</td></tr>`);
  const bugs = b.bugs.map(x => html`<li><span class="mk">${mark(x.free)}</span> <code>${x.bug.file}:${x.bug.line}</code> <span class="dim">came in with “${x.bug.subject}”, fixed by “${x.bug.fixSubject}”</span></li>`);
  return html`<div class="card card-pad stack-12"><div class="card-title">From your own history</div>
    <div class="callout ${b.rows.length > 1 ? 'callout-ai' : ''}">${ico.shield}<div><b>${b.freeProven} of ${b.total} real past bugs were caught by the free checks alone, with proof, when they came in</b> (${b.freeSeen - b.freeProven} more flagged, ${b.total - b.freeSeen} missed), at 0 tokens. ${b.rows.length > 1 ? html`With the reviewers: ${b.seen} of ${b.total} flagged by someone.` : 'The reviewers have not been run yet.'} <span class="dim">${plural(b.elsewhere, 'more flag')} elsewhere in those commits are not counted: nobody knows those lines are clean. A removed line is a proxy for the defect, so this is a sample of your own history, not a verdict.</span></div></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Reviewer</th><th class="num">Caught</th><th class="num">Flagged only</th><th class="num">Missed</th><th class="num" title="About four characters to a token unless the agent reported its use">Tokens per catch</th><th>What it suggests</th></tr></thead><tbody>${rows}</tbody></table></div>
    <ul class="pastbugs">${bugs}</ul>
    ${b.rows.length > 1 ? '' : html`<p class="dim limit-copy">Assay never calls a model, so your agent runs them. Give it this; the scoreboard fills in as they report.</p><textarea class="brief" readonly rows="5" aria-label="What to give your agent for the replay">${p.prompt}</textarea>`}
    <p class="dim">${b.commits === 1 ? 'One commit' : `${b.commits} commits`} replayed, ${new Date(b.createdAt).toISOString().slice(0, 10)}. <code>assay calibrate history clean</code> forgets it.</p></div>`;
}

function scoreHTML() {
  const base = plantedHTML();
  const cal = S.rv.cal;
  return cal && !S.rv.calError ? html`${base}${pastHTML(cal.past)}` : base;
}

function plantedHTML() {
  const cal = S.rv.cal;
  if (S.rv.calError) return html`<div class="callout" role="alert">${ico.alert}<div><b>That didn’t work.</b><br><span class="dim">${S.rv.calError}</span></div></div>`;
  if (!cal) return loading('Scoreboard', 'Reading the scoreboard…');
  const running = S.rv.calRunning;
  const btn = html`<button class="btn btn-second" data-act="rv-calibrate" ${running ? 'disabled' : ''}>${running ? html`<span class="spinner"></span> ${running}` : html`${ico.play} ${cal.board ? 'Plant a fresh set of bugs' : 'Plant bugs and test the reviewers'}`}</button>`;
  if (!cal.board) {
    const p = cal.preview;
    return html`<div class="card card-pad stack-12"><div class="card-title">Who do you trust?</div>
      <p class="dim limit-copy">Assay plants known bugs in a throwaway repository shaped like yours (your languages, your folders), each with a clean twin written correctly. It scores the free checks on the spot, then your agent runs the reviewers on both, and each one is scored on what it caught and on what it flagged in clean code. A reviewer that catches none of the bugs planted in its lens two runs in a row is left out of plans. Nothing in your project is touched, and nothing is spent until your agent runs the reviewers.</p>
      ${p && p.fit.length ? html`<p>This project would get <b>${p.fit.length}</b> planted bugs: ${[...new Set(p.fit.map(f => f.lens))].join(', ')}. ${p.skipped.length ? html`<span class="dim">Left out: ${[...new Set(p.skipped.map(s => s.why))].join(' ')}</span>` : ''}</p>` : html`<p class="dim">This project has no JavaScript, TypeScript, Python, CSS, HTML or package.json for the bugs to be shaped after.</p>`}
      <div>${p && p.fit.length ? btn : ''}</div></div>`;
  }
  const b = cal.board;
  const rows = b.rows.map(r => html`<tr><td><b>${r.name}</b></td><td class="num">${r.ran ? r.caught : '·'}</td><td class="num">${r.ran ? r.flagged : '·'}</td><td class="num">${r.ran ? r.missed : '·'}</td><td class="num">${r.ran ? r.alarms : '·'}</td><td class="num">${r.id === 'free' ? '0' : r.perCatch !== null ? html`${k(r.perCatch)}${r.tokensKind === 'estimate' ? '~' : ''}` : '—'}</td><td class="dim">${r.advice}</td></tr>`);
  const hasPlain = b.rows.some(r => r.id === 'plain');
  const head = html`<div class="mx-row ${hasPlain ? 'mx-8' : 'mx-7'} mx-head"><div>Planted bug</div>${['free', ...COLS, ...(hasPlain ? ['plain'] : [])].map(l => html`<div title="${l === 'free' ? 'Free checks (no model)' : l}">${SHORT[l]}</div>`)}</div>`;
  const body = b.bugs.map((x, i) => html`<div class="mx-row ${hasPlain ? 'mx-8' : 'mx-7'}"><div>${i + 1}. ${x.bug.name}</div><div>${mark(x.free)}</div>${COLS.map(l => html`<div>${mark(x.cells[l])}</div>`)}${hasPlain ? html`<div>${mark(x.plain)}</div>` : ''}</div>`);
  return html`<div class="toolbar">${btn}<button class="btn btn-sm btn-ghost" data-act="rv-calclear">Clear the throwaway repositories</button></div>
    <div class="callout ${b.reviewersRan ? 'callout-ai' : ''}">${ico.shield}<div><b>${b.freeProven} of ${b.planted} planted bugs were caught by the free checks alone, with proof, at 0 tokens</b> (${b.freeSeen - b.freeProven} more flagged, ${b.planted - b.freeSeen} missed, ${b.rows[0].alarms ? b.rows[0].alarms + ' false alarms' : 'no false alarms'} on the clean twins). ${b.reviewersRan ? html`With the reviewers: ${b.seen} of ${b.planted} flagged by someone.${b.complete ? '' : ' Not every reviewer has reported yet.'}` : 'The reviewers have not been run yet.'}</div></div>
    ${cal.routedOut.length ? html`<div class="callout">${ico.alert}<div><b>Left out of plans:</b>${cal.routedOut.map(x => html`<br>${x.lens}: ${x.why}`)}<br><span class="dim">Bring one back with <code>assay reviewers plan --include &lt;lens&gt;</code>.</span></div></div>` : ''}
    ${b.reviewersRan ? '' : html`<div class="card card-pad stack-12"><div class="card-title">Now the reviewers</div><p class="dim limit-copy">Assay never calls a model, so your agent runs them. Give it this; the scoreboard fills in as they report.</p><textarea class="brief" readonly rows="5" aria-label="What to give your agent">${cal.prompt}</textarea><div class="toolbar"><button class="btn btn-sm" data-act="copycmd" data-cmd="${cal.prompt}">${ico.copy} Copy for your agent</button></div></div>`}
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Reviewer</th><th class="num" title="Caught, with proof">Caught</th><th class="num" title="Flagged without proof">Flagged only</th><th class="num" title="A bug in its own lens that it missed">Missed</th><th class="num" title="Flags on the clean twins">False alarms</th><th class="num" title="About four characters to a token unless the agent reported its use (~ means estimate)">Tokens per catch</th><th>What it suggests</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="mx" role="table" aria-label="Which reviewer caught which planted bug">${head}${body}</div>
    <div class="legend"><span><b class="lg-c">✓</b> caught with proof</span><span><b class="lg-h">~</b> flagged, no proof</span><span><b class="lg-m">✗</b> missed</span><span>· not its lens</span><span>? not run</span><span>Planted ${new Date(b.createdAt).toISOString().slice(0, 10)} in a throwaway repository: these numbers come from your own project’s shape.</span></div>`;
}

export function pageReviewers() {
  if (S.rv.error && !S.rv.data) return problem('Reviewers', S.rv.error);
  if (!S.rv.data) return loading('Reviewers', 'Planning the panel…');
  const d = S.rv.data;
  const p = d.panel;
  const run = p.reviewers.filter(r => r.run).length;
  const opts = [[0, 'Free only'], [20000, '20k tokens'], [40000, '40k tokens'], [80000, '80k tokens']];
  if (!opts.some(o => o[0] === d.repoBudget)) opts.push([d.repoBudget, `${k(d.repoBudget)} tokens`]);
  const stepsHTML = steps(d).map(([n, s, st], i) => html`<div class="step ${st === 'running' ? 'running' : st === 'done' ? 'done' : st === 'skipped' ? 'skipped' : ''}"><span class="n">${i + 1}</span><b>${n}</b><small>${st === 'running' ? 'running…' : s}</small></div>`);
  const note = !d.kept ? html`<div class="callout">${ico.search}<div><b>${d.budget ? 'This is a preview.' : 'Free checks only.'}</b> ${d.budget ? html`${run} of 7 reviewers would run for this case, about ${k(p.estimate.total)} tokens. Nothing is spent until your agent runs them: Assay doesn’t call a model. The free checks cost nothing and have already run. Change the budget to see what drops out.` : html`The budget is free-only, so the reviewers stay off. Everything the free checks found is already in the case file.`}</div></div>` : '';
  const drift = d.kept && d.repoBudget !== d.budget ? html`<div class="callout">${ico.alert}<div><b>The budget is now ${k(d.repoBudget)}, but this plan was made with ${k(d.budget)}.</b> <span class="dim">Planning again uses the new budget and starts the panel over.</span></div></div>` : '';
  const head = html`<div class="page-head"><div><h1 class="page-title">Reviewers</h1><p class="page-sub">Independent, blind, one lens each. Nothing they say counts without evidence.</p></div>
    <div class="toolbar"><label class="dim" for="rvbudget">Budget</label><select id="rvbudget">${opts.map(([v, l]) => html`<option value="${v}" ${d.repoBudget === v ? 'selected' : ''}>${l}</option>`)}</select></div></div>`;
  const plan = d.budget > 0 ? html`<div class="card card-pad stack-12"><div class="card-title">Run it</div>
    <p class="dim limit-copy">Assay never calls a model, so it can’t run the reviewers itself: your own agent does, as sub-agents. Plan them here so the plan is kept with the case, then give your agent this:</p>
    <label class="dim" for="rvreq">What was asked for (optional: lets Triage trace each change back to it)</label>
    <textarea id="rvreq" class="input rv-request" rows="2" maxlength="2000" placeholder="For example: show coupon errors in the cart">${S.rv.request}</textarea>
    <div class="toolbar"><button class="btn btn-second" data-act="rv-plan">${ico.users} ${d.kept ? 'Plan again' : 'Plan these reviewers'} · ~${k(p.estimate.total)}</button>${d.kept ? html`<span class="inline-note">${ico.check} Kept with the case</span>` : ''}</div>
    <textarea class="brief" readonly rows="5" aria-label="What to give your agent">${d.prompt}</textarea>
    <div class="toolbar"><button class="btn btn-sm" data-act="copycmd" data-cmd="${d.prompt}">${ico.copy} Copy for your agent</button><span class="dim">Or hand one reviewer its brief yourself: <code>assay reviewers brief &lt;lens&gt;</code></span></div></div>` : '';
  const tabs = html`<div class="segmented" role="group" aria-label="Reviewers"><button data-act="rv-tab" data-v="panel" aria-pressed="${String(S.rv.tab !== 'score')}">The panel</button><button data-act="rv-tab" data-v="score" aria-pressed="${String(S.rv.tab === 'score')}">Scoreboard</button></div>`;
  if (S.rv.tab === 'score') return html`<div class="page page-wide">${head}${tabs}${scoreHTML()}</div>`;
  return html`<div class="page page-wide">${head}${tabs}${drift}${note}${d.status.next && d.kept ? html`<div class="callout" role="status">${ico.users}<div><b>Where it stands:</b> ${d.status.phase === 'off' ? 'not running' : d.status.phase}. ${d.status.next}</div></div>` : ''}
    <div class="stepper">${stepsHTML}</div><div class="rgrid">${p.reviewers.map(r => cardHTML(r, d.kept))}</div>${meterHTML(d)}${plan}${gateHTML(d)}</div>`;
}

/* ---------------------------------------------------------------- what the buttons do */
ACT['rv-tab'] = async el => {
  S.rv.tab = el.dataset.v === 'score' ? 'score' : 'panel';
  sync();
  try { S.rv.cal = await api('/api/calibration'); S.rv.calError = null; } catch (e) { S.rv.calError = e.message; }
  stopPoll();
  if (livePhase(S.rv.data) || calLive()) timer = setInterval(tick, 2500);
  render();
};

ACT['rv-calibrate'] = async () => {
  if (S.rv.calRunning) return;
  S.rv.calRunning = 'Planting the bugs…';
  S.rv.calError = null;
  render();
  try {
    const job = await runJob('/api/calibration/start', {}, j => { S.rv.calRunning = (j.messages[j.messages.length - 1] || 'Planting the bugs…'); if (S.rv.tab === 'score') render(); });
    if (job.state === 'failed') throw new Error(job.error || 'It did not finish.');
    S.rv.cal = job.result || await api('/api/calibration');
  } catch (e) { S.rv.calError = e.message; }
  S.rv.calRunning = null;
  stopPoll();
  if (calLive()) timer = setInterval(tick, 2500);
  render();
};

ACT['rv-calclear'] = async () => {
  try { S.rv.cal = await api('/api/calibration/clean', {}); } catch (e) { S.rv.calError = e.message; }
  render();
};
ACT['rv-plan'] = async el => {
  await morph(el, async () => {
    try {
      S.rv.data = await api('/api/panel/plan', { case: S.caseId, request: S.rv.request });
      S.view = null;
      S.rv.error = null;
      stopPoll();
      if (livePhase(S.rv.data)) timer = setInterval(tick, 2500);
      return { ok: true, label: 'Planned' };
    } catch (e) { return { ok: false, label: String(e.message || 'Failed').slice(0, 40) }; }
  }, { busy: 'Planning…', hold: 500 });
  render();
};

document.addEventListener('change', async ev => {
  if (!ev.target || ev.target.id !== 'rvbudget') return;
  try {
    await api('/api/panel/budget', { budget: Number(ev.target.value) });
    S.rv.data = await api(`/api/panel?case=${encodeURIComponent(S.caseId)}`);
    S.rv.error = null;
    stopPoll();
    if (livePhase(S.rv.data)) timer = setInterval(tick, 2500);
  } catch (e) { S.rv.error = e.message; }
  render();
});

document.addEventListener('input', ev => { if (ev.target && ev.target.id === 'rvreq') S.rv.request = ev.target.value; });
