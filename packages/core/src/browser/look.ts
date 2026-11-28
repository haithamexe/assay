import fs from 'node:fs';
import path from 'node:path';
import { buildFinding } from '../analysis.js';
import type { RawFinding } from '../checks/types.js';
import { assayPath, sha } from '../config.js';
import { commitDiff, type FileDiff } from '../diff.js';
import { applyRuns } from '../proof/apply.js';
import { repoSettings, type RepoSettings } from '../proof/settings.js';
import { exportTree, linkDependencies, removeTree } from '../proof/tree.js';
import { saveCase } from '../store.js';
import type { Case, Evidence, Finding, Lens, RunRecord, Severity, ShotRecord } from '../types.js';
import { Browser, type Page } from './cdp.js';
import { findBrowser } from './find.js';
import { addedLineWith, findTranslationFiles, readTranslations, TEXTS_SRC, translationLibrary, translationMatcher, untranslatedTexts, whereWords, type PageText } from './i18n.js';
import { callsOf, compareCalls, heavierThan, medianPerf, slowerThan, type CallChange, type CallSummary } from './health.js';
import { ARABIC_RESTORE_SRC, ARABIC_SRC, DIFF_SRC, INSPECT_SRC, PERF_INIT_SRC, PERF_READ_SRC, PROBE_NAMES_SRC, probeTypeSrc, type InPageProblem, type InspectResult, type PagePerf } from './inspect.js';
import { devServer, staticServer, type Served } from './serve.js';

export interface LookOptions {
  /** Paths to look at. Default: what the person configured, else the HTML files the range changed (or / for a dev server). */
  pages?: string[];
  /** Type a harmless marker into the page's fields and its query string and see if the page turns it into an element. Default true. */
  probe?: boolean;
  /** Keep before and after screenshots. Default true. */
  screens?: boolean;
  /** Load each page three more times at each end (desktop, light) to compare how fast it is (D62). Default true. */
  speed?: boolean;
  /** Stop starting new pages after this long. Default 300. */
  budgetSeconds?: number;
  /** Look without saving anything to the case (used by replay). */
  persist?: boolean;
  /** Stop: no new page is started, and what was measured so far is thrown away. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface LookReport {
  ran: boolean;
  reason?: string;
  mode?: 'static' | 'dev';
  browser?: string;
  pages: string[];
  combos: number;
  base: { pages: number; problems: number } | null;
  head: { pages: number; problems: number } | null;
  newProblems: number;
  probeHits: number;
  looksDifferent: number;
  /** How fast each page loaded at each end (the median of three loads), and what got clearly slower or heavier (D62). */
  speed?: Array<{ page: string; base: PagePerf; head: PagePerf; slower?: string; heavier?: string }>;
  /** What changed underneath on each page: its data calls, its console warnings, its title (D62). Only the worse ones are findings. */
  calls?: Array<{ page: string; changes: CallChange[] }>;
  /** The translation check (D63): the files read at the head, the library, how many texts the pages showed and how many of them no file has. */
  translation?: { files: number; library?: string; texts: number; untranslated: number; note?: string };
  secs: number;
  stopped?: string;
}

const VIEWPORTS = [{ id: 'desktop', label: 'desktop', w: 1280, h: 800, mobile: false }, { id: 'phone', label: 'phone', w: 390, h: 844, mobile: true }] as const;
const SCHEMES = ['light', 'dark'] as const;
const DIRS = [{ id: 'native', label: 'as loaded' }, { id: 'rtl', label: 'mirrored (right to left)' }, { id: 'ar', label: 'with Arabic text (mirrored, the text swapped for longer Arabic)' }] as const;
/** Share of pixels that must change for a picture to count as different: about 100 pixels of a desktop screen, so a small shift counts and rendering noise doesn't. */
export const SHOT_DIFFERENT = 0.0001;
const PAYLOAD = '"\'><assay-probe data-assay></assay-probe>';
export const COMBOS = VIEWPORTS.length * SCHEMES.length * DIRS.length;
const comboLabel = (id: string): string => { const [v, s, d] = id.split('|'); return `${v}, ${s} scheme, ${d === 'rtl' ? 'mirrored' : d === 'ar' ? 'with Arabic text' : 'as loaded'}`; };

export interface Problem extends InPageProblem { combo: string; key: string }
interface ProbeHit { kind: 'param' | 'input'; name: string; key: string }
export interface PageScan {
  path: string;
  ok: boolean;
  error?: string;
  problems: Problem[];
  exceptions: string[];
  consoleErrors: string[];
  failed: string[];
  probes: ProbeHit[];
  /** The first load's data calls, console warnings and title (desktop, light, as loaded). */
  calls: CallSummary[];
  warnings: string[];
  title?: string;
  /** The first load's readable texts and the data in its JSON script tags, for the translation check. */
  texts: PageText[];
  data: string;
  /** Three more loads, for speed; empty when speed wasn't asked for. */
  perf: PagePerf[];
}
interface I18n { files: string[]; library?: string; match: (text: string) => boolean }
export interface SideScan { pages: PageScan[]; shots: Map<string, Buffer>; i18n?: I18n }

/** The checkout's translation files, read once per end. */
function readI18n(dir: string): I18n {
  const files = findTranslationFiles(dir);
  return { files: files.map(f => path.relative(dir, f).replace(/\\/g, '/')), library: translationLibrary(dir), match: translationMatcher(readTranslations(files)) };
}

async function probe(p: Page, origin: string, pagePath: string): Promise<ProbeHit[]> {
  const hits: ProbeHit[] = [];
  await p.viewport(1280, 800, false);
  await p.scheme('light');
  await p.goto(origin + pagePath);
  const found = await p.evaluate<{ names: string[]; inputs: number }>(PROBE_NAMES_SRC);
  const names = [...new Set([...found.names, 'q', 'query', 'search', 'name'])].slice(0, 10);
  for (let i = 0; i < found.inputs; i++) {
    const r = await p.evaluate<{ found: boolean; name: string }>(probeTypeSrc(i, PAYLOAD));
    if (r.found) hits.push({ kind: 'input', name: r.name, key: `input:${r.name}` });
    await p.goto(origin + pagePath);
  }
  const bare = pagePath.split('?')[0];
  for (const n of names) {
    try { await p.goto(`${origin}${bare}?${encodeURIComponent(n)}=${encodeURIComponent(PAYLOAD)}`); } catch { continue; }
    if (await p.evaluate<boolean>("!!document.querySelector('assay-probe')")) hits.push({ kind: 'param', name: n, key: `param:${n}` });
  }
  return hits;
}

const SPEED_LOADS = 3;

async function measureSpeed(p: Page, url: string): Promise<PagePerf[]> {
  await p.viewport(1280, 800, false);
  await p.scheme('light');
  const { identifier } = await p.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source: PERF_INIT_SRC });
  const runs: PagePerf[] = [];
  try {
    for (let i = 0; i < SPEED_LOADS; i++) {
      try { await p.goto(url); runs.push(await p.evaluate<PagePerf>(PERF_READ_SRC)); } catch { /* a load that fails is left out; fewer than two means no comparison */ }
    }
  } finally { await p.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined); }
  return runs;
}

export async function scanPage(browser: Browser, origin: string, pagePath: string, o: { probe: boolean; screens: boolean; speed: boolean }): Promise<{ scan: PageScan; shots: Map<string, Buffer> }> {
  const scan: PageScan = { path: pagePath, ok: true, problems: [], exceptions: [], consoleErrors: [], failed: [], probes: [], calls: [], warnings: [], texts: [], data: '', perf: [] };
  const shots = new Map<string, Buffer>();
  const p = await browser.newPage();
  try {
    let first = true;
    for (const vp of VIEWPORTS) {
      await p.viewport(vp.w, vp.h, vp.mobile);
      for (const scheme of SCHEMES) {
        await p.scheme(scheme);
        p.clearEvents();
        try { await p.goto(origin + pagePath); } catch (e) { scan.ok = false; scan.error = (e as Error).message; return { scan, shots }; }
        if (first) {
          if (p.docStatus !== null && p.docStatus >= 400) { scan.ok = false; scan.error = `the page answered ${p.docStatus}`; return { scan, shots }; }
          scan.exceptions = [...p.events.exceptions];
          scan.consoleErrors = [...p.events.consoleErrors];
          scan.failed = p.events.failed.filter(f => !/favicon/i.test(f.url)).map(f => `${f.status ?? 'failed'} ${f.url.replace(origin, '')} ${f.text}`.trim());
          scan.calls = callsOf(p.events.requests, origin);
          scan.warnings = [...p.events.consoleWarnings];
          scan.title = await p.evaluate<string>('document.title').catch(() => undefined);
          const read = await p.evaluate<{ texts: PageText[]; data: string }>(TEXTS_SRC).catch(() => null);
          scan.texts = read?.texts ?? [];
          scan.data = read?.data ?? '';
          first = false;
        }
        for (const dir of DIRS) {
          const id = `${vp.id}|${scheme}|${dir.id}`;
          if (dir.id === 'rtl') await p.evaluate("(function(){var d=document.documentElement;window.__assayDir=d.getAttribute('dir');d.setAttribute('dir','rtl');})()");
          if (dir.id === 'ar') await p.evaluate(ARABIC_SRC);
          const r = await p.evaluate<InspectResult>(INSPECT_SRC);
          for (const pr of r.problems) scan.problems.push({ ...pr, combo: id, key: `${pr.kind}|${pr.path}` });
          // before and after pictures: as loaded on both sizes, and mirrored on desktop (a mirrored-layout bug looks identical as loaded)
          if (o.screens && scheme === 'light' && (dir.id === 'native' || vp.id === 'desktop')) shots.set(id, await p.screenshot());
          if (dir.id === 'rtl') await p.evaluate("(function(){var d=document.documentElement;if(window.__assayDir===null)d.removeAttribute('dir');else d.setAttribute('dir',window.__assayDir);})()");
          if (dir.id === 'ar') await p.evaluate(ARABIC_RESTORE_SRC);
        }
      }
    }
    if (o.speed) scan.perf = await measureSpeed(p, origin + pagePath);
    if (o.probe) scan.probes = await probe(p, origin, pagePath);
  } finally { await p.close(); }
  return { scan, shots };
}

export function detectServe(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const has = (f: string): boolean => fs.existsSync(path.join(dir, f));
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun run' : 'npm run';
    if (pkg.scripts?.dev) return `${pm} dev`;
    if (pkg.scripts?.start && !/^(?:node|nodemon)\s+\S*(?:cli|bin)/.test(pkg.scripts.start)) return `${pm} start`;
  } catch { /* no package.json: plain files */ }
  return null;
}

function pagesFor(settings: RepoSettings, net: FileDiff[], mode: 'static' | 'dev'): string[] {
  const out: string[] = [];
  const clean = (p: string): string | null => {
    // A path on the local server. Anything with a scheme, or starting with //, is refused, not treated as a path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || p.includes('\\')) return null;
    try { const u = new URL(p.startsWith('/') ? p : `/${p}`, 'http://x'); return u.origin === 'http://x' ? u.pathname + u.search : null; } catch { return null; }
  };
  for (const p of settings.pages ?? []) { const n = clean(p); if (n) out.push(n); }
  if (!out.length && mode === 'static') for (const f of net) if (f.status !== 'deleted' && /\.html?$/i.test(f.path)) out.push(`/${f.path.replace(/\\/g, '/')}`);
  if (!out.length) out.push('/');
  return [...new Set(out)].slice(0, 6);
}

export async function withSide<T>(c: { repo: string }, commit: string, label: string, settings: RepoSettings, say: (m: string) => void, fn: (origin: string, mode: 'static' | 'dev', dir: string) => Promise<T>): Promise<T | { error: string }> {
  const dir = exportTree(c.repo, commit, label);
  linkDependencies(c.repo, dir);
  try { return await withDir(dir, `${label} ${commit.slice(0, 7)}`, settings, say, fn); } finally { removeTree(dir); }
}

/** The project's dev server (or its HTML files, served as they are) from a folder that is already there, and nothing else: the caller removes the folder. */
export async function withDir<T>(dir: string, where: string, settings: RepoSettings, say: (m: string) => void, fn: (origin: string, mode: 'static' | 'dev', dir: string) => Promise<T>): Promise<T | { error: string }> {
  let served: Served | null = null;
  try {
    const cmd = settings.serve ?? detectServe(dir);
    if (cmd) {
      say(`Starting the dev server (${cmd}) at ${where}…`);
      const s = await devServer(cmd, dir, 90);
      if ('error' in s) return { error: s.error };
      served = s;
      return await fn(s.origin, 'dev', dir);
    }
    if (!fs.readdirSync(dir).some(n => /\.html?$/i.test(n)) && !settings.pages?.length) return { error: 'There is no dev server command and no HTML file at the top of the project, so there is nothing to look at. Give one: assay allow-run --serve "<command>" --pages "/,/cart"' };
    served = await staticServer(dir);
    return await fn(served.origin, 'static', dir);
  } finally {
    if (served) await served.stop();
  }
}

/** Opens the pages at the head and at the base in a real browser and measures them. Nothing is saved. */
export async function scanRange(c: Case, opts: LookOptions = {}): Promise<{ report: LookReport; head: SideScan | null; base: SideScan | null; net: FileDiff[]; browser: Browser | null }> {
  const settings = repoSettings(c.repo);
  if (!settings.allow) throw new Error('Running this repository’s code isn’t allowed yet. A person has to turn it on: assay allow-run');
  const started = Date.now();
  const left = (): number => (opts.signal?.aborted ? 0 : (opts.budgetSeconds ?? 300) * 1000 - (Date.now() - started));
  const say = opts.onProgress ?? ((): void => {});
  const report: LookReport = { ran: false, pages: [], combos: COMBOS, base: null, head: null, newProblems: 0, probeHits: 0, looksDifferent: 0, secs: 0 };
  const done = (): void => { report.secs = Math.round((Date.now() - started) / 1000); };
  const exe = findBrowser(settings.browser);
  if (!exe) { report.reason = 'No Chromium-based browser (Chrome, Edge, Brave or Chromium) was found. Install one, or point at it: assay allow-run --browser <path>'; done(); return { report, head: null, base: null, net: [], browser: null }; }
  report.browser = path.basename(exe);
  const net = c.base || c.head ? commitDiff(c.repo, c.head, c.base) : [];
  const browser = await Browser.launch(exe);
  const doProbe = opts.probe !== false;
  const screens = opts.screens !== false;
  const speed = opts.speed !== false;
  const scan = async (origin: string, pages: string[], label: string, withProbe: boolean): Promise<SideScan> => {
    const side: SideScan = { pages: [], shots: new Map() };
    for (const pg of pages) {
      if (left() <= 0) { report.stopped = opts.signal?.aborted ? 'stopped by the person' : 'time budget used up'; break; }
      say(`Looking at ${pg} at the ${label}…`);
      const r = await scanPage(browser, origin, pg, { probe: withProbe, screens, speed });
      side.pages.push(r.scan);
      for (const [k, v] of r.shots) side.shots.set(`${pg}|${k}`, v);
    }
    return side;
  };
  try {
    let pagesUsed: string[] = [];
    const headRes = await withSide(c, c.head, 'head', settings, say, async (origin, mode, dir) => {
      report.mode = mode;
      pagesUsed = pagesFor({ ...settings, pages: opts.pages?.length ? opts.pages : settings.pages }, net, mode);
      const side = await scan(origin, pagesUsed, `head ${c.head.slice(0, 7)}`, doProbe);
      side.i18n = readI18n(dir);
      return side;
    });
    if ('error' in headRes) { report.reason = headRes.error; done(); await browser.close(); return { report, head: null, base: null, net, browser: null }; }
    report.ran = true;
    report.pages = pagesUsed;
    const wantBaseProbe = doProbe && headRes.pages.some(p => p.probes.length > 0);
    let baseRes: SideScan | null = null;
    if (c.base) {
      const r = await withSide(c, c.base, 'base', settings, say, async (origin, _mode, dir) => { const side = await scan(origin, pagesUsed, `base ${c.base!.slice(0, 7)}`, wantBaseProbe); side.i18n = readI18n(dir); return side; });
      if (!('error' in r)) baseRes = r;
      else report.reason = `The base couldn’t be opened (${r.error.split('\n')[0]}), so only what is wrong by itself can be reported.`;
    }
    report.head = { pages: headRes.pages.filter(p => p.ok).length, problems: headRes.pages.reduce((a, p) => a + p.problems.length, 0) };
    report.base = baseRes ? { pages: baseRes.pages.filter(p => p.ok).length, problems: baseRes.pages.reduce((a, p) => a + p.problems.length, 0) } : null;
    done();
    return { report, head: headRes, base: baseRes, net, browser };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

const KINDS: Record<string, { title: string; lens: Lens; sev: Severity; ref: string; maybe: string; skipNew?: boolean }> = {
  overlap: { title: 'Things overlap', lens: 'UI', sev: 'medium', ref: 'Measured', maybe: 'Content that sits on top of other content is hard to read and may not be clickable.', skipNew: true },
  clip: { title: 'Text is cut off', lens: 'UI', sev: 'medium', ref: 'Measured', maybe: 'People can’t read, or press, what is cut off.' },
  contrast: { title: 'Text is hard to read', lens: 'UI', sev: 'medium', ref: 'WCAG 1.4.3', maybe: 'People with low vision, or anyone in sunlight, won’t be able to read it.' },
  hscroll: { title: 'The page scrolls sideways', lens: 'UI', sev: 'medium', ref: 'Measured', maybe: 'Something is wider than the screen.' },
  noalt: { title: 'An image has no alt text', lens: 'UI', sev: 'low', ref: 'WCAG 1.1.1', maybe: 'Screen readers can’t say what the image is.', skipNew: true },
  noname: { title: 'A control has no accessible name', lens: 'UI', sev: 'low', ref: 'WCAG 4.1.2', maybe: 'Screen readers announce it as an unnamed button or link.', skipNew: true },
  nolabel: { title: 'A form field has no label', lens: 'UI', sev: 'low', ref: 'WCAG 1.3.1', maybe: 'People can’t tell what the field is for.', skipNew: true },
  blank: { title: 'The page shows nothing', lens: 'Correctness', sev: 'high', ref: 'Measured', maybe: 'Whatever should be there didn’t render.' },
  exception: { title: 'The page throws an uncaught error', lens: 'Correctness', sev: 'high', ref: 'Console', maybe: 'Something on the page is broken for everyone who opens it.' },
  console: { title: 'The page logs an error', lens: 'Correctness', sev: 'medium', ref: 'Console', maybe: 'Something went wrong that the page reported but didn’t stop on.' },
  network: { title: 'A request from the page fails', lens: 'Correctness', sev: 'medium', ref: 'Network', maybe: 'Part of the page is missing its data.' },
  // D62: rules and comparisons taken over from a sister tool's per-commit page checks
  nolang: { title: 'The page has no language', lens: 'UI', sev: 'low', ref: 'WCAG 3.1.1', maybe: 'A screen reader guesses which language to read it in, and may say every word wrong.', skipNew: true },
  heading: { title: 'Heading levels skip', lens: 'UI', sev: 'low', ref: 'WCAG 1.3.1', maybe: 'People who move by headings think a section is missing.', skipNew: true },
  tabindex: { title: 'A positive tabindex changes the keyboard order', lens: 'UI', sev: 'low', ref: 'WCAG 2.4.3', maybe: 'People who use a keyboard jump around the page in an order that doesn’t match what they see.', skipNew: true },
  dupid: { title: 'An id is used more than once', lens: 'UI', sev: 'low', ref: 'Measured', maybe: 'A label or an aria reference points at the first of them, which may be the wrong one.', skipNew: true },
  warning: { title: 'The page logs a new warning', lens: 'Correctness', sev: 'low', ref: 'Console', maybe: 'The framework or the browser noticed something that may break later.' },
  calls: { title: 'The page calls the same thing more often', lens: 'Performance', sev: 'low', ref: 'Network', maybe: 'A call made twice is usually a duplicated effect or a missing cache: more load on the server and a slower page.' },
  slow: { title: 'The page loads clearly slower', lens: 'Performance', sev: 'medium', ref: 'Measured', maybe: 'People wait longer before they see the page. Measured on the dev build, so the size of the change matters more than the numbers.' },
  heavy: { title: 'The page loads clearly more script', lens: 'Performance', sev: 'low', ref: 'Measured', maybe: 'More to download and run before the page responds, most of all on a phone.' },
  untranslated: { title: 'Text that isn’t in the translation files', lens: 'UI', sev: 'low', ref: 'Measured', maybe: 'It never reaches a translator, so people who use the app in another language see it in this one.' }
};

const UI_FILE = /\.(css|scss|sass|less|vue|svelte|html?|tsx|jsx)$/i;
const SCRIPT_FILE = /\.([cm]?[jt]sx?|vue|svelte)$|(^|\/)package\.json$/i;
const SINK = /innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write|v-html|\{@html/;

/** Where in the diff a rendered problem most likely came from: a changed line that names one of the element's classes or ids, else the changed UI file. */
function anchorUi(net: FileDiff[], tokens: string[], sink = false, prefer: RegExp = UI_FILE): { file: FileDiff; line: number; text: string } | null {
  const usable = net.filter(f => !f.binary && f.status !== 'deleted' && f.hunks.length > 0).sort((a, b) => Number(prefer.test(b.path)) - Number(prefer.test(a.path)));
  if (sink) {
    for (const f of usable) for (const h of f.hunks) for (const l of h.lines) if (l.t === '+' && l.n !== null && SINK.test(l.text)) return { file: f, line: l.n, text: l.text };
  }
  const bare = tokens.map(t => t.slice(1)).filter(t => t.length > 2);
  if (bare.length) {
    // 1. a changed line that itself names the class or id, in a stylesheet before anything else: that is the rule that did it
    const sheets = [...usable].sort((a, b) => Number(/\.(css|scss|sass|less)$/i.test(b.path)) - Number(/\.(css|scss|sass|less)$/i.test(a.path)));
    for (const f of sheets) for (const h of f.hunks) for (const l of h.lines) if (l.t === '+' && l.n !== null && bare.some(t => l.text.includes(t))) return { file: f, line: l.n, text: l.text };
    // 2. an unchanged line that names it, and the changed line nearest to it
    for (const f of usable) for (const h of f.hunks) {
      const at = h.lines.findIndex(l => bare.some(t => l.text.includes(t)));
      if (at === -1) continue;
      for (let d = 0; d < h.lines.length; d++) {
        for (const i of [at + d, at - d]) { const l = h.lines[i]; if (l && l.t === '+' && l.n !== null) return { file: f, line: l.n, text: l.text }; }
      }
    }
  }
  const f = usable.find(x => prefer.test(x.path)) ?? usable[0];
  const row = f?.hunks.flatMap(h => h.lines).find(l => l.t === '+' && l.n !== null);
  return f && row && row.n !== null ? { file: f, line: row.n, text: row.text } : null;
}

/** Kinds that are a comparison of the two ends, whose detail already says what it was at the base. */
/** The texts a head page shows that no translation file has, that the base page didn't already show untranslated, and that a changed line wrote (at most 10). */
function newUntranslated(hp: PageScan, bp: PageScan, head: I18n | undefined, base: I18n | undefined, net: FileDiff[]): Array<PageText & { at: { file: string; line: number } }> {
  if (!head?.files.length) return [];
  // A base with no translation files had every text untranslated: only what is new is the change's.
  const before = new Set(untranslatedTexts(bp.texts, bp.data, base?.files.length ? base.match : () => false).map(t => t.text));
  const out: Array<PageText & { at: { file: string; line: number } }> = [];
  for (const t of untranslatedTexts(hp.texts, hp.data, head.match)) {
    if (before.has(t.text) || out.length >= 10) continue;
    const at = addedLineWith(net, t.text);
    if (at) out.push({ ...t, at });
  }
  return out;
}

const COMPARED = new Set(['calls', 'warning', 'slow', 'heavy', 'untranslated']);

/** A call's path as something a changed line may contain: "/api/orders/" for "GET /api/orders/{id}". anchorUi drops a token's first character. */
const callTokens = (key: string): string[] => {
  const p = key.slice(key.indexOf(' ') + 1).split('{')[0];
  return p.length > 3 ? [`_${p}`] : [];
};

const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';

export async function diffShot(browser: Browser, a: Buffer, b: Buffer): Promise<{ ratio: number; box: ShotRecord['box']; diff: string; base: string; head: string } | null> {
  const p = await browser.newPage();
  try {
    return await p.evaluate(`(${DIFF_SRC})(${JSON.stringify(`data:image/png;base64,${a.toString('base64')}`)}, ${JSON.stringify(`data:image/png;base64,${b.toString('base64')}`)})`);
  } catch { return null; } finally { await p.close(); }
}

const dataToFile = (dir: string, name: string, url: string): string => { fs.writeFileSync(path.join(dir, name), Buffer.from(url.split(',')[1] ?? '', 'base64')); return name; };

/** Looks at the pages at the base and at the head, keeps what is new at the head as measured findings, and keeps before and after screenshots. */
export async function lookCase(c: Case, opts: LookOptions = {}): Promise<LookReport> {
  const { report, head, base, net, browser } = await scanRange(c, opts);
  if (opts.signal?.aborted) { await browser?.close(); report.ran = false; report.reason = 'Stopped by the person. Nothing was kept.'; return report; }
  if (!report.ran || !head || !browser) return report;
  try {
    const h7 = c.head.slice(0, 7);
    const b7 = c.base ? c.base.slice(0, 7) : 'the start';
    const rec: RunRecord = { id: `r-${sha([c.head, 'browser', report.pages.join(',')].join('\0'), 8)}`, kind: 'browser', at: new Date().toISOString(), secs: report.secs, command: `${report.browser} (${report.mode})`, summary: '', findings: [], signals: [], shots: [] };
    const make = (raw: RawFinding): Finding => buildFinding(raw, { commit: c.head, files: net }, 'run');
    const push = (kind: string, page: string, items: Array<{ key: string; combo?: string; detail: string; tokens?: string[]; file?: string }>, newPage: boolean, rtlOnly: boolean, proofKind: 'measurement' | 'probe' | 'behaviour-diff', arabicOnly = false): void => {
      const meta = KINDS[kind];
      // A slower or heavier page is most likely the script that changed (or the manifest that brought a package in), not the markup.
      const a = anchorUi(net, items.flatMap(i => i.tokens ?? []), proofKind === 'probe', items[0]?.file ? new RegExp(`^${items[0].file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : kind === 'slow' || kind === 'heavy' ? SCRIPT_FILE : UI_FILE);
      if (!a) return;
      const evidence = items.slice(0, 4).map((i, n) => ({
        kind: proofKind, source: `browser:${kind}`,
        what: `On ${page}${i.combo ? ` (${comboLabel(i.combo)})` : ''} at ${h7}: ${i.detail}${n === 0 ? (newPage || COMPARED.has(kind) ? '.' : `. Not there at ${b7}.`) : '.'}`,
        run: { kind: 'look' as const, file: page, op: i.key }
      }));
      rec.findings.push(make({
        check: 'browser', key: `${kind}:${page}`, title: `${proofKind === 'probe' ? 'Text typed into the page becomes markup' : meta.title}${proofKind === 'probe' ? '' : ` on ${page}`}${arabicOnly ? ' with Arabic text' : rtlOnly ? ' when mirrored (right to left)' : ''}`,
        lens: proofKind === 'probe' ? 'Security' : meta.lens, severity: proofKind === 'probe' ? 'high' : meta.sev, file: a.file.path, line: a.line, side: 'added', text: a.text, evidence,
        observed: [`Measured in a real browser: ${items.length} ${items.length === 1 ? 'case' : 'cases'} on ${page}${newPage ? '' : COMPARED.has(kind) ? ` against ${b7}` : `, none at ${b7}`}.`, ...items.slice(0, 3).map(i => `${i.combo ? `${comboLabel(i.combo)}: ` : ''}${i.detail}.`)],
        inferred: [proofKind === 'probe' ? 'Anyone who can get a person to open a crafted link, or to paste text into the field, can run script in their session.' : meta.maybe],
        ref: proofKind === 'probe' ? 'CWE-79' : meta.ref
      }));
    };

    for (const hp of head.pages) {
      const bp = base?.pages.find(x => x.path === hp.path);
      const newPage = !bp || !bp.ok;
      if (!hp.ok) {
        if (bp && bp.ok) push('blank', hp.path, [{ key: 'blank|page', detail: `the page no longer opens (${hp.error ?? 'error'})` }], false, false, 'measurement');
        continue;
      }
      const baseKeys = new Set(bp?.problems.map(p => `${p.combo}|${p.key}`) ?? []);
      const fresh = hp.problems.filter(p => !baseKeys.has(`${p.combo}|${p.key}`) && !(newPage && KINDS[p.kind].skipNew));
      for (const kind of new Set(fresh.map(p => p.kind))) {
        const group = fresh.filter(p => p.kind === kind);
        const byKey = new Map<string, Problem[]>();
        for (const p of group) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
        const items = [...byKey.values()].map(ps => ({ key: ps[0].key, combo: ps[0].combo, detail: ps[0].detail, tokens: ps[0].tokens }));
        const mirrored = (combo: string): boolean => combo.endsWith('|rtl') || combo.endsWith('|ar');
        const rtlOnly = group.every(p => mirrored(p.combo)) && hp.problems.every(p => p.kind !== kind || mirrored(p.combo) || baseKeys.has(`${p.combo}|${p.key}`));
        const arabicOnly = group.every(p => p.combo.endsWith('|ar')) && hp.problems.every(p => p.kind !== kind || p.combo.endsWith('|ar') || baseKeys.has(`${p.combo}|${p.key}`));
        push(kind, hp.path, items, newPage, rtlOnly, 'measurement', arabicOnly);
      }
      const events = (name: 'exception' | 'console' | 'network', now: string[], before: string[] | undefined): void => {
        const nw = now.filter(m => !(before ?? []).includes(m));
        if (nw.length) push(name, hp.path, nw.map(m => ({ key: `${name}|${m}`, detail: m })), newPage, false, 'measurement');
      };
      events('exception', hp.exceptions, bp?.exceptions);
      events('console', hp.consoleErrors, bp?.consoleErrors);
      events('network', hp.failed, bp?.failed);
      const baseProbe = new Set(bp?.probes.map(p => p.key) ?? []);
      const hits = hp.probes.filter(p => !baseProbe.has(p.key));
      if (hits.length) push('probe', hp.path, hits.map(p => ({ key: p.key, detail: p.kind === 'param' ? `opening ?${p.name}=<probe> made the page create an element from it` : `typing the probe into the "${p.name}" field made the page create an element from it` })), newPage, false, 'probe');
      if (newPage || !bp) continue;
      // Text no translation file has (D63): new at the head, and written by a changed line, so data and old text are left alone.
      const fresh18 = newUntranslated(hp, bp, head.i18n, base?.i18n, net);
      if (fresh18.length) push('untranslated', hp.path, fresh18.map(x => ({ key: `untranslated|${x.text}`, detail: `the page shows "${x.text}" (${whereWords(x.where)}), written at ${x.at.file}:${x.at.line}, and none of the ${head.i18n!.files.length} translation file${head.i18n!.files.length === 1 ? '' : 's'} has it`, tokens: [`_${x.text}`], file: x.at.file })), false, false, 'measurement');
      // What changed underneath (D62): every change is listed in the report; only the worse ones are findings.
      const changes = compareCalls(bp, hp);
      if (changes.length) (report.calls ??= []).push({ page: hp.path, changes });
      const more = changes.filter(x => x.kind === 'call-count' && x.tone === 'worse');
      if (more.length) push('calls', hp.path, more.map(x => ({ key: `calls|${x.key}`, detail: x.text, tokens: callTokens(x.key!) })), false, false, 'behaviour-diff');
      const warned = changes.filter(x => x.kind === 'warning-new');
      if (warned.length) push('warning', hp.path, warned.map(x => ({ key: `warning|${x.key}`, detail: x.text })), false, false, 'measurement');
      const hm = medianPerf(hp.perf), bm = medianPerf(bp.perf);
      if (hm && bm) {
        const slower = slowerThan(hp.perf, bp.perf);
        const heavier = heavierThan(hm, bm);
        (report.speed ??= []).push({ page: hp.path, base: bm, head: hm, ...(slower ? { slower } : {}), ...(heavier ? { heavier } : {}) });
        if (slower) push('slow', hp.path, [{ key: 'slow|page', detail: `${slower} (the middle of ${hp.perf.length} loads at each end, every load at the head slower than every load at the base)` }], false, false, 'measurement');
        if (heavier) push('heavy', hp.path, [{ key: 'heavy|page', detail: heavier }], false, false, 'measurement');
      }
    }
    if (head.i18n && (head.i18n.files.length || head.i18n.library)) {
      const ok = head.pages.filter(x => x.ok);
      report.translation = {
        files: head.i18n.files.length, ...(head.i18n.library ? { library: head.i18n.library } : {}),
        texts: ok.reduce((n, x) => n + x.texts.length, 0),
        untranslated: head.i18n.files.length ? ok.reduce((n, x) => n + untranslatedTexts(x.texts, x.data, head.i18n!.match).length, 0) : 0,
        ...(head.i18n.files.length ? {} : { note: `The project uses ${head.i18n.library}, but no translation file was found in a locales, i18n, messages or translations folder, so nothing was compared.` })
      };
    }
    report.newProblems = rec.findings.filter(f => f.evidence[0].kind === 'measurement' || f.evidence[0].kind === 'behaviour-diff').length;
    report.probeHits = rec.findings.filter(f => f.evidence[0].kind === 'probe').length;

    if (base && opts.screens !== false) {
      const dir = assayPath('shots', c.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [k, headShot] of head.shots) {
        const baseShot = base.shots.get(k);
        if (!baseShot) continue;
        const d = await diffShot(browser, baseShot, headShot);
        if (!d) continue;
        const [pg, combo] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
        const stem = `${slug(pg)}-${slug(combo)}`;
        // What was measured in this very picture and wasn't there at the base: the same rule as the findings, so a box never shows something that isn't a finding.
        const hp = head.pages.find(x => x.path === pg);
        const bp = base.pages.find(x => x.path === pg);
        const baseKeys = new Set(bp?.problems.map(p => `${p.combo}|${p.key}`) ?? []);
        const newPage = !bp || !bp.ok;
        const marks = (hp?.problems ?? [])
          .filter(p => p.combo === combo && p.box && p.box.w > 0 && p.box.h > 0 && !baseKeys.has(`${p.combo}|${p.key}`) && !(newPage && KINDS[p.kind].skipNew))
          .slice(0, 12).map(p => ({ kind: p.kind, ...p.box!, label: p.detail }));
        rec.shots!.push({ page: pg, combo, marks, changed: Math.round(d.ratio * 10000) / 10000, box: d.box, base: dataToFile(dir, `${stem}.base.jpg`, d.base), head: dataToFile(dir, `${stem}.head.jpg`, d.head), diff: dataToFile(dir, `${stem}.diff.jpg`, d.diff) });
      }
      report.looksDifferent = rec.shots!.filter(s => s.changed >= SHOT_DIFFERENT).length;
    }
    rec.summary = `${report.pages.length} page${report.pages.length > 1 ? 's' : ''} opened in a real browser (${COMBOS} sizes, schemes and directions each): ${rec.findings.length} new problem${rec.findings.length === 1 ? '' : 's'}${report.probeHits ? `, ${report.probeHits} probe hit${report.probeHits === 1 ? '' : 's'}` : ''}${report.looksDifferent ? `, ${report.looksDifferent} page${report.looksDifferent > 1 ? 's look' : ' looks'} different` : ''}`;
    if (opts.persist !== false) {
      c.runs = [...c.runs.filter(r => r.kind !== 'browser'), rec];
      c.findings = c.findings.filter(f => f.origin !== 'run');
      applyRuns(c);
      saveCase(c);
    }
    return report;
  } finally {
    await browser.close();
  }
}

/** Looks at one page again at both ends and says whether the same thing is still there at the head and still not at the base. */
export async function replayLook(c: Case, ev: Evidence): Promise<{ reproduced: boolean; detail: string }> {
  const run = ev.replay?.run;
  if (!run || run.kind !== 'look' || !run.file || !run.op) return { reproduced: false, detail: 'This evidence has no page to look at again.' };
  const isProbe = run.op.startsWith('param:') || run.op.startsWith('input:');
  const kindOf = run.op.slice(0, Math.max(0, run.op.indexOf('|')));
  const compared = ['calls', 'warning', 'slow', 'heavy', 'untranslated'].includes(kindOf);
  const { report, head, base, browser } = await scanRange(c, { pages: [run.file], probe: isProbe, screens: false, speed: kindOf === 'slow' || kindOf === 'heavy' });
  try {
    if (!report.ran || !head) return { reproduced: false, detail: report.reason ?? 'The page could not be opened.' };
    if (compared) {
      // A comparison (D62) is about both ends at once: it is redone, not looked up on each side.
      const hp = head.pages.find(p => p.path === run.file && p.ok), bp = base?.pages.find(p => p.path === run.file && p.ok);
      if (!hp || !bp) return { reproduced: false, detail: `Opened ${run.file} again, but ${hp ? 'the base' : 'the head'} didn’t open, so the two can’t be compared.` };
      const rest = run.op.slice(run.op.indexOf('|') + 1);
      const changes = compareCalls(bp, hp);
      if (kindOf === 'untranslated') {
        const t = newUntranslated(hp, bp, head.i18n, base?.i18n, commitDiff(c.repo, c.head, c.base)).find(x => x.text === rest);
        return { reproduced: !!t, detail: t ? `Opened ${run.file} again at both ends: it shows "${t.text}" at the head, written at ${t.at.file}:${t.at.line}, and no translation file has it.` : `Opened ${run.file} again at both ends: the text is translated now, or no longer shown.` };
      }
      const again = kindOf === 'calls' ? changes.find(x => x.kind === 'call-count' && x.tone === 'worse' && x.key === rest)?.text
        : kindOf === 'warning' ? changes.find(x => x.kind === 'warning-new' && x.key === rest)?.text
          : kindOf === 'slow' ? slowerThan(hp.perf, bp.perf) : heavierThan(medianPerf(hp.perf), medianPerf(bp.perf));
      return { reproduced: !!again, detail: again ? `Opened ${run.file} again at both ends: ${again}.` : `Opened ${run.file} again at both ends: the difference is gone${kindOf === 'slow' ? ' (speed varies; it counts only when every load at the head is slower)' : ''}.` };
    }
    const has = (s: SideScan | null): boolean => !!s?.pages.some(p => {
      if (isProbe) return p.probes.some(x => x.key === run.op);
      const sep = run.op!.indexOf('|');
      const k = run.op!.slice(0, sep), rest = run.op!.slice(sep + 1);
      if (k === 'exception') return p.exceptions.includes(rest);
      if (k === 'console') return p.consoleErrors.includes(rest);
      if (k === 'network') return p.failed.includes(rest);
      return p.problems.some(x => x.key === run.op);
    });
    const here = has(head), before = has(base);
    return { reproduced: here && !before, detail: here && !before ? `Opened ${run.file} again at both ends: it is there at ${c.head.slice(0, 7)} and not at the base.` : `Opened ${run.file} again: ${here ? 'it is at the head and at the base too' : 'it is not at the head any more'}.` };
  } finally { await browser?.close(); }
}
