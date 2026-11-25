import { ACT, S, render } from './state.js';
import { api, html, ico, loading, problem } from './lib.js';

/* Settings: what Assay uses, what it is allowed to run, and what it found on this computer. Whether it may run the project's code
   is shown here and never changed here: a person switches that on in a terminal. */

export async function loadSettings() {
  S.settings = await api('/api/settings');
}

const cmdline = cmd => html`<div class="cmdline"><code>${cmd}</code><button class="btn btn-sm" data-act="copycmd" data-cmd="${cmd}">${ico.copy} Copy</button></div>`;
const rows = list => html`<div class="facts facts-wide">${list.map(([k, v]) => html`<div class="k">${k}</div><div>${v}</div>`)}</div>`;

export function pageSettings() {
  if (S.error && !S.settings) return problem('Settings', S.error);
  if (!S.settings) return loading('Settings', 'Reading the settings…');
  const s = S.settings;
  const st = s.settings;
  const dim = t => html`<span class="dim">${t}</span>`;
  return html`<div class="page"><div class="page-head"><div><h1 class="page-title">Settings</h1><p class="page-sub">What Assay uses, and what it may run.</p></div></div>
    <section class="section"><h2 class="section-title">Appearance</h2><div class="segmented" role="group" aria-label="Theme">${[['auto', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => html`<button data-act="theme" data-v="${v}" aria-pressed="${String(S.theme === v)}">${l}</button>`)}</div></section>
    <section class="section"><h2 class="section-title">This project</h2>${rows([['Repository', html`<code>${s.path}</code>`], ['Branch', s.branch], ['Assay', s.version], ['State folder', html`<code>${s.home}</code>`]])}
      <p class="dim">Everything Assay keeps (cases, results of runs, pictures) is in the state folder. Nothing leaves this computer.</p></section>
    <section class="section"><h2 class="section-title">Reviewers</h2><div class="card card-pad stack-12">${rows([['Budget', `${s.budget ? `${s.budget.toLocaleString('en')} tokens for a panel` : 'Free only: the reviewers stay off'}`], ['Who runs them', 'Your own agent, as sub-agents. Assay plans them, hands each one its slice and counts what comes back; it never calls a model.']])}
      <p class="dim">Set the budget on the Reviewers screen. A Stop hook makes your agent unable to say “done” while Assay’s own verdict is Blocked. Assay doesn’t edit your agent’s settings, so this prints what to add:</p>${cmdline(s.hookCommand)}</div></section>
    <section class="section"><h2 class="section-title">Running this project’s code ${st.allow ? html`<span class="badge badge-ok">${ico.check} Allowed</span>` : html`<span class="badge">Off</span>`}</h2>
      <div class="card card-pad stack-12">${rows([
        ['Test command', s.test ? html`<code>${s.test}</code>` : dim('none found. Give one with assay allow-run --command "<your test command>"')],
        ['Time limit', `${st.timeout} seconds per run`],
        ['Dev server', st.serve ? html`<code>${st.serve}</code>` : dim('found from package.json (dev or start); plain HTML files are served as they are')],
        ['Pages', st.pages ? st.pages.join(', ') : dim('the HTML files a range changes, or / for a dev server')],
        ['Browser', s.browserFound ? s.browserFound : dim('none found: install Chrome, Edge, Brave or Chromium, or point at one with assay allow-run --browser <path>')]
      ])}
      ${st.allow
        ? html`<p class="dim">Assay runs the test command and the dev server in clean copies of commits under the state folder, and deletes them afterwards. It never changes your repository. To turn it off:</p>${cmdline(s.allowOff)}`
        : html`<p class="dim">The test and page checks run this project’s own code, so only a person can switch them on, in a terminal. Nothing in this dashboard, and nothing an agent can do, switches it on.</p>${cmdline(s.allowCommand)}`}</div></section>
    <section class="section"><h2 class="section-title">What Assay found on this computer</h2><div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Tool</th><th>State</th></tr></thead><tbody>${s.doctor.map(r => html`<tr><td><b>${r.name}</b></td><td><span class="badge ${r.ok === true ? 'badge-ok' : r.ok === false ? 'badge-danger' : ''}">${r.ok === true ? html`${ico.check} Found` : r.ok === false ? 'Problem' : 'Optional'}</span> <span class="dim">${r.note}</span></td></tr>`)}</tbody></table></div></div>
      <p class="dim">Only git and Node are needed. The others add evidence if they are found.</p></section></div>`;
}

ACT.theme = el => {
  S.theme = el.dataset.v;
  const r = document.documentElement;
  if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
  try { localStorage.setItem('assay-theme', S.theme); } catch { /* the choice just isn't kept */ }
  render();
};
