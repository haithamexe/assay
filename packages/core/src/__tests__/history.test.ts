import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { makeRepo, SECRET, tempHome } from './fixtures.js';

/* Replaying the project's own history (D52): the line a fix removed is where the bug came in; that commit, alone, is the case. */
tempHome();
const core = await import('../index.js');
const { calibration: cal, reviewers: rv, memory } = core;
after(() => memory.closeMemory());

const CART_OK = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`;
const BUGS = `${CART_OK}
export function render(el, text) {
  el.innerHTML = text;
  return el;
}

export function count(items) {
  let n = 0;
  for (const item of items) {
    n += item.qty;
  }
  return n;
}

export function label(items) {
  const n = count(items);
  return n === 1 ? '1 item' : n + ' items';
}

export function last(items) {
  return items[items.length];
}
`;
const FIXED = BUGS.replace('el.innerHTML = text;', 'el.textContent = text;').replace('items[items.length]', 'items[items.length - 1]');

function project(): { repo: ReturnType<typeof makeRepo>; base: string; intro: string; fix: string } {
  const repo = makeRepo('shop');
  const base = repo.commit({ 'src/cart.js': CART_OK, 'README.md': '# shop\n' }, 'Base');
  const intro = repo.commit({ 'src/cart.js': BUGS }, 'Show errors and the last item in the cart');
  repo.commit({ 'src/footer.js': 'export const footer = "bye";\n' }, 'Add a footer');
  repo.commit({ 'src/cart.js': `${BUGS}\nexport const EMPTY = [];\n` }, 'fix: handle empty carts');
  repo.commit({ 'src/names.js': 'export const a = 1;\nexport const b = 2;\n', 'src/footer.js': null }, 'refactor: rename things and drop the footer');
  const fix = repo.commit({ 'src/cart.js': `${FIXED}\nexport const EMPTY = [];\n` }, 'fix: show errors as text and take the real last item');
  return { repo, base, intro, fix };
}

const lineOf = (repo: ReturnType<typeof makeRepo>, commit: string, file: string, needle: string): number => repo.git('show', `${commit}:${file}`).split('\n').findIndex(l => l.includes(needle)) + 1;

test('the lines a fix removed lead to the commit that wrote them, at the line number that commit gave them', () => {
  const { repo, intro, fix } = project();
  const { bugs, looked } = cal.findPastBugs(repo.dir);
  assert.equal(bugs.length, 2);
  assert.ok(looked >= 2, 'the fix that only added a line was looked at too, and gave nothing');
  for (const b of bugs) {
    assert.equal(b.fix, fix);
    assert.equal(b.introduced, intro);
    assert.equal(b.file, 'src/cart.js');
    assert.equal(b.subject, 'Show errors and the last item in the cart');
    assert.equal(b.case, '', 'nothing is opened until a run is started');
  }
  assert.deepEqual(bugs.map(b => b.line).sort((a, b) => a - b), [lineOf(repo, intro, 'src/cart.js', 'el.innerHTML'), lineOf(repo, intro, 'src/cart.js', 'items[items.length]')]);
  assert.ok(bugs.some(b => /innerHTML/.test(b.text)));
  assert.ok(bugs.every(b => b.fixSubject.startsWith('fix:')), 'only a commit that says it is a fix is used: the refactor that removed lines is not');
});

test('a project with no fix commits has nothing to replay, and says so', () => {
  const repo = makeRepo('plain');
  repo.commit({ 'a.js': 'export const a = 1;\n' }, 'One');
  repo.commit({ 'a.js': 'export const a = 2;\n' }, 'Two');
  assert.deepEqual(cal.findPastBugs(repo.dir).bugs, []);
  assert.throws(() => cal.startHistory(repo.dir), /No fix commits were found/);
});

test('a key a fix removed is masked, and the free checks score it as proven', () => {
  const repo = makeRepo('keys');
  repo.commit({ 'src/app.js': 'export const a = 1;\n' }, 'Base');
  repo.commit({ 'src/app.js': `export const a = 1;\nexport const API_KEY = "${SECRET}";\n` }, 'Add the api client');
  repo.commit({ 'src/app.js': 'export const a = 1;\n' }, 'fix: remove the committed key');
  const run = cal.startHistory(repo.dir);
  assert.equal(run.bugs.length, 1);
  assert.ok(!JSON.stringify(run).includes(SECRET), 'the key is not in the run, the case file or the board');
  assert.match(run.bugs[0].text, /AKIA…/);
  const b = cal.scoreHistory(run);
  assert.equal(b.bugs[0].free, 'C', 'a committed key is a proven finding when it came in');
  assert.ok(!JSON.stringify(b).includes(SECRET));
});

test('a replay opens the commit each bug came in at, scores the free checks on it, and a reviewer or the plain review scored on the same line', () => {
  const { repo, base, intro } = project();
  const run = cal.startHistory(repo.dir, { budget: 100000 });
  assert.equal(run.bugs.length, 2);
  assert.ok(run.bugs.every(b => b.case === core.caseId(intro, base)), 'one case, the commit alone');
  assert.equal(cal.latestHistory(repo.dir)?.id, run.id, 'the run is kept');
  const c = core.loadCase(run.bugs[0].case)!;
  assert.equal(c.base, base);
  assert.equal(c.head, intro);
  assert.equal(c.panel?.baseline?.run, true, 'the plain review is planned on it');
  assert.equal(c.panel?.attack?.run, true, 'and the attack pass, on a budget this big');
  assert.match(cal.historyPrompt(run), new RegExp(`${c.id}.*lens "plain".*don't look at any commit after a case's head`));

  // the free checks, the moment the commit is read: the html sink is flagged, the off-by-one is not
  let b = cal.scoreHistory(run);
  const html = b.bugs.find(x => /innerHTML/.test(x.bug.text))!;
  const off = b.bugs.find(x => /items\[items\.length\]/.test(x.bug.text))!;
  assert.notEqual(html.free, 'm');
  assert.equal(off.free, 'm');
  assert.deepEqual([b.total, b.commits, b.freeSeen, b.complete, b.plainRan], [2, 1, 1, false, false]);
  assert.equal(b.rows[0].id, 'free');
  assert.match(b.rows[0].advice, /Flagged 1 of 2 real past bugs/);

  // the reviewers: Correctness finds the off-by-one, the attack pass finds the sink, one plain review finds only the off-by-one
  const all = (who: string, name: string, claims: Array<{ line: number }>): void => {
    const cc = core.loadCase(run.bugs[0].case)!;
    const lens = rv.reviewerFor(who)?.lens ?? 'Correctness';
    const gated = core.applyClaims(cc.repo, cc, claims.map(x => ({ title: 'Something is wrong here', lens, file: 'src/cart.js', line: x.line, what: 'This line does something it should not, and here is why it matters.', source: `reviewer:${name}` })));
    core.saveCase(cc);
    rv.recordSubmission(cc, who, gated, { round: 1, done: true, tokens: 1000, claims: claims.length, disputes: [] });
  };
  const offLine = off.bug.line;
  const htmlLine = html.bug.line;
  for (const r of core.loadCase(run.bugs[0].case)!.panel!.reviewers.filter(x => x.run)) all(r.lens, r.lens, r.lens === 'Correctness' ? [{ line: offLine }] : []);
  all('attack', 'Attack', [{ line: htmlLine }]);
  all('plain', 'Plain', [{ line: offLine }]);
  b = cal.scoreHistory(run);
  assert.equal(b.complete, true);
  assert.equal(b.plainRan, true);
  assert.equal(b.plainSeen, 1);
  assert.equal(b.seen, 2, 'someone flagged both');
  const row = (id: string): ReturnType<typeof cal.scoreHistory>['rows'][number] => b.rows.find(r => r.id === id)!;
  assert.deepEqual([row('Correctness').hits, row('attack').hits, row('plain').hits], [1, 1, 1]);
  assert.equal(b.bugs.find(x => x.bug.id === off.bug.id)!.cells.Correctness, 'h');
  assert.equal(b.bugs.find(x => x.bug.id === off.bug.id)!.plain, 'h');
  assert.equal(b.bugs.find(x => x.bug.id === html.bug.id)!.plain, 'm');
  assert.equal(b.bugs.find(x => x.bug.id === html.bug.id)!.attack, 'h');
  assert.match(row('plain').advice, /One plain review flagged 1 of 2; the panel flagged 2\. The lenses are adding something\./);
  assert.equal(b.rows.at(-1)!.id, 'plain');
  assert.equal(row('plain').tokens, 1000);

  // clearing it removes the run and nothing of the project's
  assert.equal(cal.clearHistory(repo.dir), true);
  assert.equal(cal.latestHistory(repo.dir), null);
});

test('replaying history only reads: the project’s working tree and HEAD are exactly as they were', () => {
  const { repo } = project();
  const head = repo.git('rev-parse', 'HEAD').trim();
  const before = repo.git('status', '--porcelain') + repo.git('branch', '--list');
  cal.startHistory(repo.dir);
  assert.equal(repo.git('rev-parse', 'HEAD').trim(), head);
  assert.equal(repo.git('status', '--porcelain') + repo.git('branch', '--list'), before);
});
