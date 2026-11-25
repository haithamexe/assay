import { ACT, S, parseHash, render, sync } from './state.js';
import { $, api, html, ico, loading, morph, plural, problem, put, runJob, short, timeAgo } from './lib.js';

/* Memory: the mistakes this project has made (from standards packs and from its own history), the packs themselves, and learning from
   fix commits. Reading is free; switching things on and off is the person's. Nothing a page or an agent sends can add a pattern of its
   own: the only way in is a suggestion Assay made from this project's git history. */

export async function loadMemory() {
  S.mem.data = await api('/api/memory');
}

const STATUS = {
  new: ['New', 'badge-accent'], active: ['Active', 'badge-ok'], expiring: ['Expiring', 'badge-warn'],
  expired: ['Cried wolf', 'badge-danger'], off: ['Off', ''], question: ['Question', '']
};
const statusBadge = e => { const [l, c] = STATUS[e.status] || [e.status, '']; return html`<span class="badge ${c}">${l}</span>`; };
const PACK_TAG = { 'owasp-top10': 'OWASP', wcag22: 'WCAG', tests: 'Tests', pages: 'Pages', basics: 'Basics', 'review-questions': 'Ask' };
/** A short code for the list: a learned entry's id, a criterion or category when the reference starts with one, else the pack. */
const codeOf = e => {
  if (e.kind === 'learned') return e.id;
  const first = String(e.ref || '').split(/[ ·]/)[0];
  return /^(?:[A-Z]\d{2}|\d(?:\.\d+)+|CWE-\d+)$/.test(first) ? first : PACK_TAG[e.pack] || String(e.pack || '').slice(0, 6);
};
const counts = e => (e.how === 'question' ? 'ask' : `${e.stats.hits}`);

/** The changes memory makes to what a case finds are only seen the next time a case is opened, so the timeline and the case are read again. */
function changed() {
  S.timeline = null;
  S.cases = null;
}

/** A change the person asked for. If the server refuses, the page says what it said and keeps what it had. */
async function change(path, body) {
  try {
    S.mem.data = await api(path, body);
    S.mem.error = null;
    changed();
    return { ok: true };
  } catch (e) {
    S.mem.error = e.message;
    return { ok: false, label: String(e.message || 'Failed').slice(0, 40) };
  }
}

function entries() {
  const d = S.mem.data;
  const q = S.mem.q.trim().toLowerCase();
  const rank = e => (e.kind === 'learned' ? 0 : 1);
  return d.entries
    .filter(e => (S.mem.kind === 'all' || (S.mem.kind === 'question' ? e.how === 'question' : e.kind === S.mem.kind)) && (!q || `${e.name} ${e.ref || ''} ${e.id} ${e.langs.join(' ')} ${e.origin}`.toLowerCase().includes(q)))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || b.e.stats.hits - a.e.stats.hits || a.i - b.i)
    .map(x => x.e);
}

function listHTML() {
  const list = entries();
  if (!list.length) return html`<div class="zero">Nothing matches.</div>`;
  return html`${list.map(e => html`<button class="memrow ${e.on ? '' : 'is-off'}" data-act="mem-sel" data-id="${e.id}" aria-pressed="${String(S.mem.sel === e.id)}"><span class="mono dim">${codeOf(e)}</span><span><b>${e.name}</b><br><span class="dim sub">${e.kind === 'learned' ? 'Learned here' : e.ref || e.origin}${e.langs.length ? ` · ${e.langs.join(', ')}` : ''}</span></span><span class="badge ${STATUS[e.status] ? STATUS[e.status][1] : ''}">${STATUS[e.status] ? STATUS[e.status][0] : e.status}${e.how === 'question' ? '' : ` · ${counts(e)}`}</span></button>`)}`;
}

function matchedHTML(e) {
  const v = S.view;
  if (!v || !v.memory) return html`<p class="dim">No case is open, so there is nothing to match it against.</p>`;
  const hit = v.case.findings.filter(f => (v.memory[f.id] || []).some(m => m.id === e.id));
  if (!hit.length) return html`<p class="dim">Not matched in the case that is open.</p>`;
  return html`<div class="callout">${ico.file}<div><b>Matched in the case that is open:</b> ${hit.map(f => html`<a href="#/case?id=${encodeURIComponent(v.case.id)}&item=${f.id}">${f.title}</a>`)}</div></div>`;
}

function detailHTML(e) {
  const s = e.stats;
  const rate = s.hits ? Math.round((s.falseAlarms / s.hits) * 100) : 0;
  const mx = Math.max(1, ...s.weeks);
  const can = S.mem.data.available;
  const ex = e.examples || [];
  const action = e.off === 'pack'
    ? html`<span class="inline-note">${ico.lock} Its pack is off. Switch the pack on under Standards.</span>`
    : e.on
      ? html`<button class="btn btn-sm" data-act="mem-entry" data-id="${e.id}" data-v="off" ${can ? '' : 'disabled'}>Switch off</button>`
      : html`<button class="btn btn-sm btn-primary" data-act="mem-entry" data-id="${e.id}" data-v="on" ${can ? '' : 'disabled'}>Switch on</button>`;
  const forget = e.kind === 'learned'
    ? S.mem.confirm === e.id
      ? html`<button class="btn btn-sm btn-ghost" data-act="mem-remove" data-id="${e.id}">${ico.alert} Press again to forget it</button>`
      : html`<button class="btn btn-sm btn-ghost" data-act="mem-remove" data-id="${e.id}" ${can ? '' : 'disabled'}>Forget this</button>`
    : '';
  return html`<article class="card"><div class="detail-head"><div class="badges"><span class="mono dim">${e.id}</span>${statusBadge(e)}<span class="badge ${e.kind === 'learned' ? 'badge-accent' : ''}">${e.kind === 'learned' ? 'Learned here' : 'Standard'}</span>${e.ref ? html`<span class="badge">${e.ref}</span>` : ''}${e.langs.length ? html`<span class="chip-lang">${e.langs.join(' · ')}</span>` : ''}</div><h3>${e.name}</h3><p class="dim">${e.origin}</p></div>
    <div class="tabbody"><div class="facts facts-wide"><div class="k">Found by</div><div>${e.detector}</div>${e.pattern ? html`<div class="k">Pattern</div><div><code>${e.pattern.source}</code></div>` : ''}
      ${e.how === 'question'
        ? html`<div class="k">Ask</div><div>${e.question}</div>`
        : html`<div class="k">Seen</div><div>${plural(s.hits, 'time')}${s.lastHit ? html`, last ${s.lastHit.slice(0, 10)}` : ''}</div><div class="k">Dismissed as false alarms</div><div><span class="fpbar"><i><b data-css="width:${rate}%"></b></i>${s.falseAlarms} of ${s.hits} (${rate}%)</span></div><div class="k">Last 12 weeks</div><div><span class="spark" role="img" aria-label="Hits per week, oldest first: ${s.weeks.join(', ')}">${s.weeks.map(w => html`<i data-css="height:${Math.max(2, (w / mx) * 26)}px"></i>`)}</span></div>`}</div>
      ${e.bad || e.good ? html`<div class="kv kv-2"><div class="h">Bad</div><div class="h">Good</div><div class="bad mono">${e.bad || ''}</div><div class="good mono">${e.good || ''}</div></div>` : ''}
      ${ex.length ? html`<div class="stack-12"><b>Fixed before in this project (${e.fixes} ${e.fixes === 1 ? 'time' : 'times'})</b>${ex.map(x => html`<div class="example"><span class="mono dim">${short(x.commit)}</span> ${x.subject}<div class="mono bad">${x.bad}</div>${x.good ? html`<div class="mono good">${x.good}</div>` : ''}</div>`)}</div>` : ''}
      ${e.status === 'expiring' ? html`<div class="callout">${ico.alert}<div>More than ${Math.round(S.mem.data.expiry.falseShare * 100)}% of its alarms were dismissed. With no real hit for ${S.mem.data.expiry.quietDays} days it switches itself off.</div></div>` : ''}
      ${e.status === 'expired' ? html`<div class="callout">${ico.alert}<div>It cried wolf, so it switched itself off. What it found is no longer reported. Switch it on again if you want it back.</div></div>` : ''}
      ${e.how === 'question' ? '' : matchedHTML(e)}
      <div class="detail-actions">${action}${forget}</div></div></article>`;
}

function mistakes() {
  const list = entries();
  const sel = list.find(e => e.id === S.mem.sel) || S.mem.data.entries.find(e => e.id === S.mem.sel) || list[0];
  const kinds = [['all', 'All'], ['standard', 'Standard'], ['learned', 'Learned here'], ['question', 'Questions']];
  return html`<div class="mem"><div class="card"><div class="card-head"><div class="segmented" role="group" aria-label="Kind">${kinds.map(([k, l]) => html`<button data-act="mem-kind" data-v="${k}" aria-pressed="${String(S.mem.kind === k)}">${l}</button>`)}</div><input id="memq" class="input right" type="search" placeholder="Search" value="${S.mem.q}" aria-label="Search mistakes"></div><div id="memlist">${listHTML()}</div></div>
    ${sel ? detailHTML(sel) : html`<div class="card card-pad"><p class="dim">Nothing to show.</p></div>`}</div>`;
}

function standards() {
  const d = S.mem.data;
  const on = d.packs.filter(p => p.on);
  const checked = on.reduce((n, p) => n + p.checked, 0);
  const rules = on.reduce((n, p) => n + p.rules, 0);
  return html`<div class="card"><div class="card-head"><span class="card-title">Standards packs</span><span class="dim">${on.length} on · ${checked} of ${rules} rules are checked by Assay; the rest become questions for a reviewer</span></div>
    ${d.packs.map(p => html`<div class="pack"><label class="check"><input type="checkbox" data-act="mem-pack" data-id="${p.id}" ${p.on ? 'checked' : ''} ${d.available ? '' : 'disabled'} aria-label="${p.name}"></label><div><b>${p.name}</b> ${p.edition ? html`<span class="badge">${p.edition}</span>` : ''} ${p.origin === 'yours' ? html`<span class="badge badge-accent">Yours</span>` : ''}<br><span class="dim">${p.note}</span>${p.source ? html` <a href="${p.source}" target="_blank" rel="noopener noreferrer">Source</a>` : ''}</div><div class="pack-meter"><span class="dim sub">${p.checked} of ${p.rules} checked by Assay</span><span class="autobar"><b data-css="width:${(p.checked / p.rules) * 100}%"></b></span></div></div>`)}</div>
    ${d.problems.length ? html`<div class="callout">${ico.alert}<div><b>A pack file was skipped.</b>${d.problems.map(t => html`<br><span class="dim">${t}</span>`)}</div></div>` : ''}
    <p class="dim">Packs are plain files you can read and edit: the ones that ship with Assay, and yours in <code>${d.packsDir}</code>. A pack of yours with the same id replaces the bundled one, so a new edition of a standard is a file update, not a release. <code>assay memory import &lt;file&gt;</code> checks a file and copies it there.</p>`;
}

function minePanel() {
  const m = S.mem.mining;
  if (m && m.state === 'running') {
    const last = m.messages[m.messages.length - 1] || 'Starting…';
    return html`<div class="callout" role="status"><span class="spinner"></span><div><b>${last}</b><br><span class="dim">Reading git only. Nothing is run.</span></div><button class="btn btn-sm right" data-act="mem-stop">${ico.stop} Stop</button></div>`;
  }
  if (m && m.state === 'failed') return html`<div class="callout">${ico.alert}<div><b>It didn’t finish.</b><br><span class="dim">${m.error || 'Something went wrong.'}</span></div></div>`;
  if (m && m.state === 'stopped') return html`<div class="callout">${ico.alert}<div><b>Stopped.</b> <span class="dim">Nothing was kept.</span></div></div>`;
  return '';
}

function mine() {
  const d = S.mem.data;
  const r = d.mined;
  const running = S.mem.mining && S.mem.mining.state === 'running';
  const worth = r ? r.candidates.filter(c => c.worth).length : 0;
  const result = r ? html`<div class="callout">${ico.check}<div>Read <b>${r.commits}</b> commits${r.truncated ? ' (the most recent ones)' : ''}, ${timeAgo(r.at)}. <b>${r.fixes}</b> are fixes${r.skipped ? `, and ${r.skipped} bulk changes were left out` : ''}. ${r.candidates.length ? `${r.candidates.length} ${r.candidates.length === 1 ? 'pattern recurs' : 'patterns recur'} enough to suggest${worth ? `, and ${worth} look${worth === 1 ? 's' : ''} worth a detector` : ', but none looks strong'}.` : 'No pattern recurs enough to suggest. That is a fair answer: most fixes are logic, which has no shape to find.'}</div></div>
    ${r.candidates.length ? html`<div class="card">${r.candidates.map(c => {
      const added = d.minedAdded[c.id];
      const ex = c.examples[0];
      return html`<div class="pack pack-2"><div><b class="mono">${c.token}</b> ${c.worth ? html`<span class="badge badge-ok">Worth a detector</span>` : html`<span class="badge">Weak</span>`} <span class="chip-lang">${c.langs.join(' · ')}</span><br><span class="dim">Removed by ${plural(c.fixes, 'fix commit')}${c.others ? `, and by ${plural(c.others, 'other commit')}` : ''}${c.replacedBy ? `. Usually replaced by ` : '.'}${c.replacedBy ? html`<code>${c.replacedBy}</code>` : ''}</span>${ex ? html`<br><span class="dim">${short(ex.commit)} ${ex.subject}</span><div class="mono bad">${ex.bad}</div>` : ''}</div>${added ? html`<span class="badge badge-ok">${ico.check} Added as ${added}</span>` : html`<button class="btn btn-sm" data-act="mem-add" data-id="${c.id}" ${d.available ? '' : 'disabled'}>Add detector</button>`}</div>`;
    })}</div><p class="dim">An added detector runs on the lines each case adds, from the next case on. What it finds is a hint, or corroborated with the fixes behind it, and can never block a merge.</p>` : ''}` : '';
  return html`<div class="card card-pad stack-12"><div class="card-title">Learn from your own history</div><p class="dim limit-copy">Every “fix:” commit is a mistake someone already paid for. Assay reads them, keeps what fixes take away far more often than other commits do, and suggests a pattern for each. You decide what gets added. It finds calls, properties and CSS declarations that keep being removed, not logic slips like <code>&lt;</code> where <code>&lt;=</code> was meant.</p>
    <div><button class="btn btn-second" data-act="mem-mine" ${running || !d.available ? 'disabled' : ''}>${ico.search} ${r ? 'Read the history again' : 'Read the git history'}</button></div>${minePanel()}${result}</div>`;
}

export function pageMemory() {
  if (S.error && !S.mem.data) return problem('Memory', S.error);
  if (!S.mem.data) return loading('Memory', 'Reading what is remembered…');
  const d = S.mem.data;
  const tabs = [['mistakes', 'Mistakes'], ['standards', 'Standards'], ['mine', 'Learn from history']];
  return html`<div class="page page-wide"><div class="page-head"><div><h1 class="page-title">Memory</h1><p class="page-sub">Mistakes this project has made, and the standards each one is checked against. Stats keep it honest: what cries wolf switches itself off.</p></div></div>
    ${S.mem.error ? html`<div class="callout" role="alert">${ico.alert}<div><b>That didn’t work.</b><br><span class="dim">${S.mem.error}</span></div></div>` : ''}
    ${d.available ? '' : html`<div class="callout">${ico.alert}<div><b>Memory is off.</b><br><span class="dim">${d.why} The packs can still be read; nothing can be switched or learned.</span></div></div>`}
    <div class="segmented" role="group" aria-label="Memory">${tabs.map(([k, l]) => html`<button data-act="mem-tab" data-v="${k}" aria-pressed="${String(S.mem.tab === k)}">${l}</button>`)}</div>
    ${S.mem.tab === 'standards' ? standards() : S.mem.tab === 'mine' ? mine() : mistakes()}</div>`;
}

/* ---------------------------------------------------------------- what the buttons do */
ACT['mem-sel'] = el => { S.mem.sel = el.dataset.id; S.mem.confirm = null; sync(); render(); };
ACT['mem-kind'] = el => { S.mem.kind = el.dataset.v; render(); };
ACT['mem-tab'] = el => { S.mem.tab = el.dataset.v; sync(); render(); };

ACT['mem-pack'] = async el => {
  await change('/api/memory/pack', { id: el.dataset.id, on: el.checked });
  render();
};

ACT['mem-entry'] = async el => {
  const on = el.dataset.v === 'on';
  await morph(el, async () => { const r = await change('/api/memory/entry', { id: el.dataset.id, on }); return r.ok ? { ok: true, label: on ? 'Switched on' : 'Switched off' } : r; }, { busy: 'Saving…', hold: 350 });
  render();
};

ACT['mem-remove'] = async el => {
  if (S.mem.confirm !== el.dataset.id) { S.mem.confirm = el.dataset.id; render(); return; }
  S.mem.confirm = null;
  const r = await change('/api/memory/remove', { id: el.dataset.id });
  if (r.ok) { S.mem.sel = null; sync(); }
  render();
};

ACT['mem-add'] = async el => {
  await morph(el, async () => { const r = await change('/api/memory/add', { id: el.dataset.id }); return r.ok ? { ok: true, label: 'Added' } : r; }, { busy: 'Adding…', hold: 400 });
  render();
};

ACT['mem-mine'] = async () => {
  if (S.mem.mining && S.mem.mining.state === 'running') return;
  S.mem.mining = { state: 'running', id: null, messages: [] };
  render();
  try {
    const job = await runJob('/api/memory/mine', {}, j => {
      S.mem.mining = { id: j.id, state: j.state === 'queued' ? 'running' : j.state, messages: j.messages, error: j.error };
      if (parseHash().page === 'memory') render();
    });
    S.mem.mining = { id: job.id, state: job.state, messages: job.messages, error: job.error };
    if (job.state === 'done') await loadMemory();
  } catch (e) {
    S.mem.mining = { state: 'failed', id: null, messages: [], error: e.message };
  }
  render();
};

ACT['mem-stop'] = async () => {
  if (S.mem.mining && S.mem.mining.id) { try { await api('/api/stop', { id: S.mem.mining.id }); } catch { /* it ended on its own */ } }
};

/* The search box updates the list and nothing else, so typing never loses its place. */
document.addEventListener('input', ev => {
  if (ev.target && ev.target.id === 'memq') {
    S.mem.q = ev.target.value;
    const l = $('#memlist');
    if (l) put(l, listHTML());
  }
});
