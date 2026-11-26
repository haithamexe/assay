import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openCase } from '../case.js';
import { git, repoRoot } from '../git.js';
import { isGenerated, isTestPath, languageOf } from '../lang.js';
import { planPanel } from '../reviewers/plan.js';
import { type BugTemplate, type Family, lineOf, TEMPLATES } from './bugs.js';
import { type CalibrationRun, cleanRuns, runDir, saveRun, type PlantedBug } from './record.js';

/**
 * Calibration (D44): plant known bugs in a throwaway repository shaped like the project, and its clean twin, so what the free checks and the
 * reviewers do with each is measured and not believed. The throwaway holds only the files being planted (named like ordinary files, in the
 * folders the project already uses for each language), never the project's own code. Nothing in the project is touched.
 */
const FAMILY_OF: Record<string, Family> = { JavaScript: 'js', TypeScript: 'js', Vue: 'js', Svelte: 'js', Python: 'py', CSS: 'css', HTML: 'html' };
const MANIFEST_BASE = { name: 'app', version: '1.0.0', private: true, dependencies: { react: '^19.0.0', zod: '^3.24.0' } };

export interface Shape { families: Set<Family>; dirs: Partial<Record<Family, string>>; manifest: boolean }

/** Which languages the project is written in and where each lives, from the files git tracks. */
export function shapeOf(repo: string): Shape {
  const files = git(repo, ['ls-files'], { allowFail: true }).split('\n').filter(Boolean);
  const counts: Partial<Record<Family, Map<string, number>>> = {};
  for (const f of files) {
    if (isTestPath(f) || isGenerated(f) || f.split('/').some(p => p === 'node_modules' || p === 'vendor')) continue;
    const fam = FAMILY_OF[languageOf(f) ?? ''];
    if (!fam) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const m = (counts[fam] ??= new Map());
    m.set(dir, (m.get(dir) ?? 0) + 1);
  }
  const dirs: Partial<Record<Family, string>> = {};
  const families = new Set<Family>();
  for (const [fam, m] of Object.entries(counts) as Array<[Family, Map<string, number>]>) {
    families.add(fam);
    dirs[fam] = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
  }
  const manifest = files.includes('package.json');
  if (manifest) families.add('manifest');
  return { families, dirs, manifest };
}

const manifestText = (extra: Record<string, unknown> = {}, deps: Record<string, string> = {}): string =>
  `${JSON.stringify({ ...MANIFEST_BASE, ...extra, dependencies: { ...MANIFEST_BASE.dependencies, ...deps } }, null, 2)}\n`;

interface Planned { t: BugTemplate; path: string; base: string | undefined; bad: string; good: string }

function plan(shape: Shape): { planned: Planned[]; skipped: CalibrationRun['skipped'] } {
  const planned: Planned[] = [];
  const skipped: CalibrationRun['skipped'] = [];
  for (const t of TEMPLATES) {
    if (!shape.families.has(t.family)) {
      skipped.push({ id: t.id, name: t.name, why: t.family === 'manifest' ? 'The project has no package.json.' : `The project has no ${t.family === 'js' ? 'JavaScript or TypeScript' : t.family === 'py' ? 'Python' : t.family.toUpperCase()} files.` });
      continue;
    }
    let p: string;
    if (t.family === 'manifest') p = 'package.json';
    else if (t.test) p = `tests/${t.file}`;
    else { const d = shape.dirs[t.family] ?? ''; p = d ? `${d}/${t.file}` : t.file; }
    if (t.family === 'manifest') planned.push({ t, path: p, base: manifestText(), bad: manifestText({}, { reactt: '^1.0.0' }), good: manifestText({ description: 'A small shop' }) });
    else planned.push({ t, path: p, base: t.base, bad: t.bad, good: t.good });
  }
  return { planned, skipped };
}

/** What a run would plant in this project, without making anything. */
export function previewCalibration(repoIn: string): { fit: Array<{ id: string; name: string; lens: string }>; skipped: CalibrationRun['skipped']; shape: Record<string, string> } {
  const repo = repoRoot(repoIn);
  const shape = shapeOf(repo);
  const { planned, skipped } = plan(shape);
  return { fit: planned.map(p => ({ id: p.t.id, name: p.t.name, lens: p.t.lens })), skipped, shape: Object.fromEntries(Object.entries(shape.dirs).map(([k, v]) => [k, v || '.'])) };
}

const IDENT = { GIT_AUTHOR_NAME: 'Assay calibration', GIT_AUTHOR_EMAIL: 'calibration@assay.invalid', GIT_COMMITTER_NAME: 'Assay calibration', GIT_COMMITTER_EMAIL: 'calibration@assay.invalid' };

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export const CALIBRATION_BUDGET = 200_000;

/**
 * Builds the throwaway repository (a base, a branch with the bugs, a branch with their clean twins), opens a case for each, and plans the reviewer
 * panel on both. The free checks have already run by the time this returns; the reviewers are run by the person's own agent.
 */
export function startCalibration(repoIn: string, opts: { budget?: number } = {}): CalibrationRun {
  const repo = repoRoot(repoIn);
  const shape = shapeOf(repo);
  const { planned, skipped } = plan(shape);
  if (!planned.length) throw new Error('There is nothing to plant: the project has no JavaScript, TypeScript, Python, CSS, HTML or package.json for the bugs to be shaped after.');
  cleanRuns(repo);
  const id = `cal-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(runDir(id), 'repo');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const g = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env: { ...process.env, ...IDENT, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  g('init', '-q', '-b', 'main');
  write(dir, 'README.md', '# app\n');
  for (const p of planned) if (p.base !== undefined) write(dir, p.path, p.base);
  g('add', '-A');
  // A case is named after its commits' hashes, and these commits have a fixed author and are made at "now": two runs in the same second would get
  // the same hashes, and so the same case (with the earlier run's reports in it). The run id in the base commit's message makes every run its own.
  g('commit', '-q', '-m', 'Initial files', '-m', `Calibration run ${id}`);
  const base = g('rev-parse', 'HEAD').trim();
  const message = 'Add helpers';

  g('checkout', '-q', '-b', 'planted');
  for (const p of planned) write(dir, p.path, p.bad);
  g('add', '-A');
  g('commit', '-q', '-m', message);
  const plantedHead = g('rev-parse', 'HEAD').trim();

  g('checkout', '-q', 'main');
  g('checkout', '-q', '-b', 'control');
  for (const p of planned) write(dir, p.path, p.good);
  g('add', '-A');
  g('commit', '-q', '-m', message);
  const controlHead = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', 'planted');

  const bugs: PlantedBug[] = planned.map(p => {
    const line = lineOf(p.t.side === 'removed' ? (p.base as string) : p.bad, p.t.mark);
    if (!line) throw new Error(`The bug "${p.t.id}" has no line with "${p.t.mark}" in it.`);
    return { id: p.t.id, name: p.t.name, lens: p.t.lens, file: p.path, line, side: p.t.side };
  });
  const budget = Math.max(0, Math.min(400_000, Math.round(opts.budget ?? CALIBRATION_BUDGET)));
  const a = openCase({ repo: dir, span: { base, head: plantedHead } });
  const b = openCase({ repo: dir, span: { base, head: controlHead } });
  // The plain review rides along on both cases: one reviewer with no lens and no free findings, the stick the panel is measured against (D51).
  planPanel(a, { budget, baseline: true });
  planPanel(b, { budget, baseline: true });
  const run: CalibrationRun = {
    id, repo, createdAt: new Date().toISOString(), dir, base, planted: { case: a.id, head: plantedHead, bugs }, control: { case: b.id, head: controlHead },
    skipped, shape: Object.fromEntries(Object.entries(shape.dirs).map(([k, v]) => [k, v || '.'])), budget
  };
  saveRun(run);
  return run;
}

/** What to give an agent to run the reviewers on both cases. It says not to read Assay's calibration folder: the test means something only if the reviewers don't know which case holds the bugs. */
export const handoffPrompt = (planted: string, control: string): string =>
  `Review two cases with Assay's reviewer panel, one after the other, and tell me when both panels are done. Case ${planted}, then case ${control}. For each, call the assay tool reviewers_plan with that case id and follow what it says: start one sub-agent per reviewer it lists, in parallel, each told only to call reviewer_brief for its own lens and follow it (it also lists a plain review, lens "plain", and may list an attack pass, lens "attack": run them like the others). Don't show the reviewers each other's work, and don't read anything under ~/.assay/calibration: it is a test, and it only means something if the reviewers don't know which one holds the bugs.`;
