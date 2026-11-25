// Takes the pictures used in the README and the docs, with Assay's own browser client (so it needs a Chromium-based browser on the machine).
//   npm run screenshots     (run npm run samples first: two of the pictures come from the sample reports)
//   npm run screenshots -- --only memory|reviewers|scoreboard     (just that screen)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shopProject } from './shop.mjs';

const root = new URL('../', import.meta.url);
const dist = new URL('packages/core/dist/', root);
const { Browser } = await import(new URL('browser/cdp.js', dist));
const { findBrowser } = await import(new URL('browser/find.js', dist));
const exe = findBrowser();
if (!exe) { console.error('No Chromium-based browser found. Install one or set ASSAY_BROWSER.'); process.exit(1); }

const img = fileURLToPath(new URL('docs/images/', root));
fs.mkdirSync(img, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const file = rel => new URL(rel, root).href;

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const b = await Browser.launch(exe);
async function shot(url, name, { scheme = 'light', w = 1280, h = 800, ready, run } = {}) {
  const p = await b.newPage();
  await p.viewport(w, h, false);
  await p.scheme(scheme);
  await p.goto(url);
  if (ready) {
    const end = Date.now() + 30_000;
    while (Date.now() < end && !(await p.evaluate(`!!document.querySelector(${JSON.stringify(ready)})`))) await sleep(100);
  }
  if (run) await p.evaluate(run);
  await sleep(600);
  fs.writeFileSync(img + name, await p.screenshot());
  await p.close();
  console.log('docs/images/' + name);
}

/* 1. the demo (sample data) and the two sample reports */
const demo = file('demo/index.html');
if (!only) {
await shot(`${demo}#/timeline`, 'demo-timeline.png');
await shot(`${demo}#/case?item=crash`, 'demo-case-file.png');
await shot(`${demo}#/case?item=rtl&tab=ba`, 'demo-before-after.png', { h: 900, run: "(async () => { await new Promise(r => setTimeout(r, 300)); document.querySelector('.cmp-matrix').scrollIntoView({ block: 'start' }); })()" });
await shot(`${demo}#/reviewers`, 'demo-reviewers.png');
await shot(`${demo}#/case?item=crash`, 'demo-case-file-dark.png', { scheme: 'dark' });

const look = file('demo/sample-look-report.html');
await shot(look, 'report-finding.png', { h: 900, run: "(() => { const b = [...document.querySelectorAll('.citem')].find(x => /overlap/i.test(x.textContent)); if (b) b.click(); })()" });
await shot(look, 'report-before-after.png', { h: 700, run: "(() => { const f = [...document.querySelectorAll('.shot')].find(x => /mirrored/.test(x.textContent)) || document.querySelector('.shot'); if (f) f.scrollIntoView({ block: 'start' }); })()" });
}

/* 2. the real dashboard, on the sample project, after the pages were looked at once */
const fx = await import(new URL('__tests__/fixtures.js', dist));
fx.tempHome();
const core = await import(new URL('index.js', dist));
const { startDashboard } = await import(new URL('packages/web/dist/index.js', root));
const { repo, base, head } = shopProject(fx, core);
const c = core.openCase({ repo: repo.dir, span: { base, head } });
const rc0 = c.id;
const d = await startDashboard({ repo: repo.dir });
const big = { w: 1360, h: 860 };
if (!only) {
await core.lookCase(c);
const overlap = c.findings.find(f => /overlap/i.test(f.title));
await shot(d.url, 'dashboard-timeline.png', { ...big, ready: 'table.tl' });
await shot(`${d.origin}/#/case?id=${c.id}&item=${overlap.id}`, 'dashboard-case-file.png', { ...big, scheme: 'dark', ready: '.verdict' });
await shot(`${d.origin}/#/case?id=${c.id}&item=${overlap.id}&tab=ba`, 'dashboard-before-after.png', { ...big, ready: '.cmp-matrix', run: "(() => { document.querySelector('.cmp-bar').scrollIntoView({ block: 'start' }); })()" });
}

/* 3. memory: the sample project has been bitten before, so reading its history finds a pattern worth a detector; adding it and opening the case counts a hit */
if (!only || only === 'memory') {
  const mined = await core.memory.mineHistory(repo.dir);
  const cand = mined.candidates.find(x => x.worth);
  core.memory.addMined(repo.dir, cand.id);
  core.openCase({ repo: repo.dir, span: { base, head } });
  const learned = core.memory.listEntries(repo.dir).find(e => e.kind === 'learned');
  await shot(`${only ? d.url : d.origin + '/'}#/memory?id=${encodeURIComponent(learned.id)}`, 'dashboard-memory.png', { ...big, scheme: 'dark', ready: '.mem article' });
}
/* 4. reviewers: a panel part of the way through, as an agent would leave it (plan kept, Triage reported, UI working, one claim dropped by the gate) */
if (!only || only === 'reviewers') {
  const rc = core.openCase({ repo: repo.dir, span: { base, head } });
  const rv = core.reviewers;
  core.setRepoSettings(repo.dir, { budget: 60000 });
  rv.planPanel(rc, { budget: 60000, request: 'Redesign the checkout summary card' });
  const submit = (who, claims, o = {}) => {
    const c2 = core.loadCase(rc.id);
    const r = core.applyClaims(repo.dir, c2, claims.map(x => ({ ...x, source: `reviewer:${who}` })));
    core.saveCase(c2);
    rv.recordSubmission(c2, who, r, { round: 1, done: !!o.done, tokens: o.tokens, claims: claims.length, disputes: [] });
  };
  rv.reviewerBrief(core.loadCase(rc.id), 'Triage');
  submit('Scope', [
    { title: 'A new file the request doesn’t explain', lens: 'Scope', file: 'src/summary.js', line: 1, what: 'The redesign adds src/summary.js, which calls the old totals function. Nothing in the request asks for it.', severity: 'low' },
    { title: 'Release notes were not part of this', lens: 'Scope', file: 'docs/notes.md', line: 3, what: 'These notes are about something else entirely, and are not in this change.' }
  ], { done: true, tokens: 1500 });
  rv.reviewerBrief(core.loadCase(rc.id), 'UI');
  await shot(`${only ? d.url : d.origin + '/'}#/reviewers?id=${rc.id}`, 'dashboard-reviewers.png', { ...big, scheme: 'dark', h: 1000, ready: '.rgrid' });
}

/* 5. the scoreboard: bugs planted in a throwaway repository, the free checks scored, and six reviewers as an agent might leave them */
if (!only || only === 'scoreboard') {
  const run = core.calibration.startCalibration(repo.dir);
  const at = id => { const b = run.planted.bugs.find(x => x.id === id); return b ? { file: b.file, line: b.line } : null; };
  const report = (which, who, claims, tokens) => {
    const c = core.loadCase(which === 'planted' ? run.planted.case : run.control.case);
    const lens = core.reviewers.reviewerFor(who).lens;
    const list = claims.filter(Boolean).map(x => ({ title: 'Something is wrong here', lens, file: x.file, line: x.line, what: 'This line does something it should not, and here is why it matters.', source: 'reviewer:' + lens }));
    const r = core.applyClaims(c.repo, c, list);
    core.saveCase(c);
    core.reviewers.recordSubmission(c, who, r, { round: 1, done: true, tokens, claims: list.length, disputes: [] });
  };
  report('planted', 'Security', [at('html-sink'), at('hardcoded-key'), at('sql-concat'), at('shell-py'), at('n-plus-one')], 4800);
  report('control', 'Security', [], 1600);
  report('planted', 'Correctness', [at('off-by-one'), at('swapped-args'), at('removed-guard')], 4100);
  report('control', 'Correctness', [{ file: run.planted.bugs.find(b => b.id === 'swapped-args').file, line: 1 }], 1500);
  report('planted', 'UI', [at('physical-side'), at('fixed-width')], 3400);
  report('control', 'UI', [], 1200);
  report('planted', 'Tests', [at('weak-assertion')], 2600);
  report('control', 'Tests', [], 900);
  report('planted', 'Supply chain', [at('lookalike-dependency')], 2200);
  report('control', 'Supply chain', [], 800);
  report('planted', 'Performance', [at('n-plus-one')], 3000);
  report('control', 'Performance', [], 1000);
  await shot(`${only ? d.url : d.origin + '/'}#/reviewers?id=${rc0}&tab=score`, 'dashboard-scoreboard.png', { ...big, scheme: 'dark', h: 1500, ready: '.mx-row.mx-7' });
}

await d.close();
await b.close();
