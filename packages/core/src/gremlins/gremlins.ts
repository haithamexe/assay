import fs from 'node:fs';
import { Browser, type Page } from '../browser/cdp.js';
import { findBrowser } from '../browser/find.js';
import { addedLineWith } from '../browser/i18n.js';
import { withSide } from '../browser/look.js';
import { redactSecrets } from '../checks/secrets.js';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import { commitDiff, type FileDiff } from '../diff.js';
import { tierOf } from '../evidence.js';
import { repoKey, repoName, repoRoot, resolveRev } from '../git.js';
import { checkPagePath, checkUrl } from '../project/inputs.js';
import { repoSettings } from '../proof/settings.js';
import { sessionValues, type Session } from '../session.js';
import { compareRuns, keepRun, loadGremlinRun, newRunId } from './store.js';
import type { Tier } from '../types.js';

/**
 * Gremlins (D65): a headless browser goes through the project's app by itself, the way an impatient and careless person would:
 * clicking whatever it finds, typing nonsense into fields, double-clicking submit, pressing Enter, going back halfway. It is seeded,
 * so the same seed does the same things, and every problem comes with the steps that led to it. Taken over from a sister tool.
 *
 * It clicks and types, and a click can save and a typed text can be sent, so it is one of the checks that change data: it needs
 * `assay allow-run` and the person's own `assay allow-run --writes` (D64). Two ways to point it:
 *  - `url`: an app that is already running on this computer (Assay never starts it), everything it sees is reported;
 *  - no `url`: Assay starts the project's own dev server (or serves its HTML) from a clean copy of a commit, and with a `base` runs the
 *    same seed there too, so only what is new at the head is reported (D20).
 * The browser talks to this computer only: a request to anything else is refused before it leaves, and the hosts are listed.
 * It never leaves the origin it started on, goes back to the start when a link leads elsewhere, and leaves controls that look
 * destructive (delete, sign out, reset…) alone unless `bold`.
 */

export const GREMLINS_SCHEMA = 'assay.gremlins/1';
export type GremlinKind = 'exception' | 'console' | 'server' | 'network' | 'blank' | 'overlay';
export type GremlinSeverity = 'high' | 'medium' | 'low';

export interface GremlinStep {
  goto?: string;
  click?: string;
  double?: boolean;
  type?: string;
  into?: string;
  press?: 'Enter' | 'Escape';
  back?: boolean;
}

export interface GremlinFinding {
  id: string;
  kind: GremlinKind;
  severity: GremlinSeverity;
  /** The browser saw it happen, so it is proven; what it means is a person's call. Computed from the evidence. */
  tier: Tier;
  title: string;
  /** What the browser reported, secrets masked. */
  text: string;
  /** How many times it came up. */
  count: number;
  /** Which action it came after (1 is the first). */
  step: number;
  /** The page it was on. */
  url?: string;
  /** The last steps up to and including the one that caused it (at most 15), as the browser did them. */
  steps: GremlinStep[];
  /** A changed line that wrote what the problem names, when it ran on a range and one was found. */
  where?: string;
  fix: string;
  /** Against the last kept run of the same app: never seen before, new, or already there. */
  since?: 'first' | 'new' | 'before';
}

export interface GremlinsReport {
  schema: typeof GREMLINS_SCHEMA;
  /** The kept run: `assay gremlins show <id>`, `assay gremlins replay <id>`. */
  id: string;
  repo: string;
  name: string;
  /** The commit the app was started from (a range or a clean copy), or the one the repository is at (a running app). */
  commit: string;
  base?: string;
  mode: 'running' | 'copy';
  /** The running app that was gone through, in `running` mode. */
  url?: string;
  seed: number;
  /** What was asked for, and what was done. */
  planned: number;
  actions: number;
  phone: boolean;
  bold: boolean;
  browser: string;
  findings: GremlinFinding[];
  /** Problems the same seed also met at the base, so they are not new. */
  before: number;
  pages: string[];
  /** Controls left alone because they look destructive. */
  skipped: string[];
  /** Hosts the browser refused to talk to, because they are not on this computer. */
  blocked: string[];
  notes: string[];
  /** How to run it again with the same seed. */
  replay: string;
  /** The page it started on. */
  start: string;
  /** Whether it went through the app signed in (a session from the environment). The session itself is in no report. */
  signedIn: boolean;
  /** Every step it did, in order (at most 300 and the returns to the start): what `assay gremlins replay` does again, exactly. */
  trail: GremlinStep[];
  /** The last kept run of the same app this one is compared with. */
  previous: { id: string; createdAt: string; seed: number; commit: string } | null;
  /** Problems that run had and this one didn't meet. With another seed that may only mean it didn't go there. */
  gone: Array<{ id: string; kind: GremlinKind; title: string; text: string }>;
  secs: number;
  stopped?: string;
  createdAt: string;
}

export interface GremlinsOptions {
  repo: string;
  /** An app running on this computer: http://localhost:3000. Without it, the project's app is started from a clean copy of `ref`. */
  url?: string;
  /** The commit to start the app from. Default HEAD. */
  ref?: string;
  /** Run the same seed here too and report only what is new at `ref`. Not with `url`. */
  base?: string;
  /** How many things to do (default 40, at most 300). */
  actions?: number;
  seed?: number;
  /** The page to start on, a path (default: the first page set with allow-run, else `/`). */
  page?: string;
  /** A cheap phone: a narrow touch screen. */
  phone?: boolean;
  /** Also click controls that look destructive. */
  bold?: boolean;
  /** A signed-in session (a cookie, an Authorization value), from the environment only. Used with `url`; sent to that origin and nowhere else. */
  session?: Session;
  /** Keep the run, and compare it with the last one. Default true. */
  save?: boolean;
  /** Stop starting new actions after this long. Default 300. */
  budgetSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}

/** Text no form expects. */
export const JUNK = [
  '', '   ', 'x'.repeat(5000), '😀🎉👍🏽 ñ ü 中文 العربية', '<script>alert(1)</script>', "'; DROP TABLE users; --", '-1', '0', '99999999999999999999', '3.14159',
  'NaN', 'null', 'undefined', '2026-02-30', 'not-an-email', 'a@b', '../../etc/passwd', '%s%s%s%n', '{{7*7}}', '‮reversed'
];

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|drop|reset|wipe|clear all|log ?out|sign ?out|deactivate|unsubscribe|close (my )?account|uninstall)\b/i;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|[^/]*\.localhost)$/i;

/** A small seeded random number generator (mulberry32): the same seed gives the same run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: Record<GremlinKind, { title: string; sev: GremlinSeverity; fix: string }> = {
  exception: { title: 'The page throws an uncaught error', sev: 'high', fix: 'Handle what the steps lead to (an empty or odd value, a click before the data arrived, a double click). The error text says where.' },
  blank: { title: 'The page goes blank', sev: 'high', fix: 'An error during render took everything down. An error boundary, or the value the steps put in, is the place to look.' },
  overlay: { title: 'The framework’s error screen appears', sev: 'high', fix: 'The dev server caught an error the page didn’t handle. The text is what it said.' },
  server: { title: 'The server answers with an error', sev: 'medium', fix: 'The server failed on input a person could type or a request a person could repeat. Validate it and answer with a 4xx.' },
  network: { title: 'A request from the page fails', sev: 'medium', fix: 'The request didn’t get an answer. Check the page copes with that, and that the server was meant to be down.' },
  console: { title: 'The page logs an error', sev: 'low', fix: 'The page reported a problem it didn’t stop on. Read it with the steps that led to it.' }
};

interface Candidate { target: string; kind: 'click' | 'submit' | 'field'; label: string }
interface Raw { kind: GremlinKind; text: string; step: number; url?: string; count: number; steps: GremlinStep[] }
interface Round { steps: GremlinStep[]; found: Map<string, Raw>; skipped: string[]; pages: string[]; actions: number; blocked: Set<string>; missing: number; stopped?: string }

// Runs in the page: what can be clicked or typed into, each with a way to find it again (data-testid, a unique id or name, its text, its aria-label, or its place in the page).
const CANDIDATES = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0; };
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (x) { return false; } };
  const sel = (e) => {
    const t = e.getAttribute("data-testid");
    if (t && unique("[data-testid=" + JSON.stringify(t) + "]")) return "[data-testid=" + JSON.stringify(t) + "]";
    if (e.id && unique("#" + CSS.escape(e.id))) return "#" + CSS.escape(e.id);
    const name = e.getAttribute("name");
    if (name) { const s = e.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]"; if (unique(s)) return s; }
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
    const label = (e.innerText || "").trim().replace(/\s+/g, " ");
    if (!field && label && label.length <= 40) return "text=" + label;
    const aria = e.getAttribute("aria-label");
    if (aria) { const s = "[aria-label=" + JSON.stringify(aria) + "]"; if (unique(s)) return s; }
    const parts = [];
    let n = e;
    while (n && n !== document.body && parts.length < 10) {
      let i = 1, s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      n = n.parentElement;
    }
    return "body > " + parts.join(" > ");
  };
  const out = [];
  for (const e of document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem], [role=link], [role=checkbox], [role=switch], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], select, summary, [onclick]")) {
    if (out.length >= 150) break;
    if (!vis(e) || e.disabled || e.getAttribute("aria-disabled") === "true") continue;
    if (e.tagName === "A") {
      const href = e.getAttribute("href") || "";
      if (/^(mailto|tel|javascript|data|blob):/i.test(href) || e.target === "_blank" || e.hasAttribute("download")) continue;
      try { if (new URL(e.href, location.href).origin !== location.origin) continue; } catch (x) { continue; }
    }
    const submit = (e.tagName === "INPUT" && e.type === "submit") || (e.tagName === "BUTTON" && !!e.form && (e.getAttribute("type") || "submit") === "submit");
    out.push({ target: sel(e), kind: submit ? "submit" : "click", label: (e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 60) });
  }
  for (const e of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable=true], [contenteditable=\"\"]")) {
    if (out.length >= 200) break;
    if (!vis(e) || e.disabled || e.readOnly) continue;
    out.push({ target: sel(e), kind: "field", label: (e.getAttribute("aria-label") || e.placeholder || e.name || e.id || "").slice(0, 60) });
  }
  return out;
})()`;

const BLANK = String.raw`(() => {
  if (!document.body || (document.body.innerText || "").trim()) return false;
  for (const e of document.body.querySelectorAll("img, svg, canvas, video, iframe, input, button, select, textarea, vite-error-overlay, nextjs-portal")) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return false; }
  return true;
})()`;

const OVERLAY = String.raw`(() => {
  const v = document.querySelector("vite-error-overlay");
  if (v && v.shadowRoot) return v.shadowRoot.textContent.replace(/\s+/g, " ").trim().slice(0, 500);
  const n = document.querySelector("nextjs-portal");
  const d = n && n.shadowRoot && n.shadowRoot.querySelector("[data-nextjs-dialog], [data-nextjs-error-overlay]");
  if (d) return d.textContent.replace(/\s+/g, " ").trim().slice(0, 500);
  const w = document.getElementById("webpack-dev-server-client-overlay");
  return w && w.contentDocument ? w.contentDocument.body.innerText.slice(0, 500) : "";
})()`;

// A CSS selector, or "text=…" for buttons and links by their text.
const FIND_LITE = String.raw`(sel) => {
  if (!sel.startsWith("text=")) { try { return document.querySelector(sel); } catch (x) { return null; } }
  const want = sel.slice(5).trim().toLowerCase();
  const textOf = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").toLowerCase();
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const list = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], label, summary")];
  return list.find((e) => visible(e) && textOf(e) === want) || list.find((e) => visible(e) && textOf(e).includes(want)) || null;
}`;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const clip = (s: string, n = 400): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const shape = (s: string): string => s.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200);
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url.slice(0, 60); } };

/** Whether the browser may send this request: this computer, or something that never leaves the browser. */
function onThisComputer(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (/^(data|blob|about|filesystem):$/.test(u.protocol)) return true;
  if (!/^(https?|wss?):$/.test(u.protocol)) return false;
  return LOOPBACK_HOST.test(u.hostname);
}

/** One step in words: `click “Save”`, `type "<script>…" into #name`. */
export function describeStep(s: GremlinStep): string {
  const target = (t: string): string => (t.startsWith('text=') ? `“${t.slice(5)}”` : t);
  if (s.type !== undefined) return `type ${JSON.stringify(s.type.length > 30 ? `${s.type.slice(0, 30)}…` : s.type)} into ${target(s.into ?? '')}`;
  if (s.click) return `${s.double ? 'double-click' : 'click'} ${target(s.click)}`;
  if (s.press) return `press ${s.press}`;
  if (s.back) return 'go back';
  if (s.goto) return `go to ${s.goto}`;
  return 'wait';
}

async function round(browser: Browser, origin: string, start: string, o: { actions: number; seed: number; phone: boolean; bold: boolean; deadline: number; signal?: AbortSignal; say: (m: string) => void; session?: Session; script?: GremlinStep[] }): Promise<Round> {
  const random = seeded(o.seed);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const run: Round = { steps: [], found: new Map(), skipped: [], pages: [], actions: 0, blocked: new Set(), missing: 0 };
  const secrets = sessionValues(o.session);
  const scrub = (t: string): string => secrets.reduce((a, v) => a.split(v).join('[session]'), t);
  const authorization = o.session?.authorization;
  const page: Page = await browser.newPage();
  try {
    if (o.phone) { await page.viewport(390, 844, true); await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); } else await page.viewport(1280, 800, false);
    // Only this computer is ever talked to: the app's own code may call a payment service or a mail server, and a gremlin must not reach it.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    page.cdp.on('Fetch.requestPaused', (p, sid) => {
      if (sid !== page.sessionId) return;
      const url = String(p.request?.url ?? '');
      const ok = onThisComputer(url);
      if (!ok) run.blocked.add(hostOf(url));
      // The session's Authorization goes to the app's own origin and to nothing else.
      let headers: Array<{ name: string; value: string }> | undefined;
      if (ok && authorization && url.startsWith(`${origin}/`)) headers = [...Object.entries((p.request?.headers ?? {}) as Record<string, string>).filter(([n]) => n.toLowerCase() !== 'authorization').map(([name, value]) => ({ name, value: String(value) })), { name: 'Authorization', value: authorization }];
      void page.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId, ...(headers ? { headers } : {}) } : { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
    });
    // An alert or a confirm would stop the page until someone answers: say no.
    page.cdp.on('Page.javascriptDialogOpening', (_p, sid) => { if (sid === page.sessionId) void page.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined); });

    // A session cookie is set on the app's own origin before the first page.
    if (o.session?.cookie) {
      for (const part of o.session.cookie.split(';')) {
        const at = part.indexOf('=');
        if (at < 1) continue;
        await page.send('Network.setCookie', { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim(), url: origin, path: '/' }).catch(() => undefined);
      }
    }
    let current: GremlinStep | undefined;
    const note = (kind: GremlinKind, rawText: string, rawUrl?: string): void => {
      const text = scrub(rawText), url = rawUrl === undefined ? undefined : scrub(rawUrl);
      const key = `${kind} ${shape(text)}`;
      const f = run.found.get(key);
      if (f) { f.count++; return; }
      if (run.found.size >= 100) return;
      const steps = [...run.steps, ...(current ? [current] : [])];
      run.found.set(key, { kind, text: clip(text), step: steps.length, url, count: 1, steps: steps.slice(-15).map(s => ({ ...s })) });
    };
    const startUrl = new URL(start, origin).href;
    const home = new URL(startUrl).pathname + new URL(startUrl).search;
    const pending = (): boolean => page.events.requests.some(r => r.status === null && !r.error && r.type !== 'WebSocket' && r.type !== 'EventSource');
    const idle = async (max: number): Promise<void> => {
      const end = Date.now() + max;
      await sleep(150);
      while (Date.now() < end && pending()) await sleep(100);
      await sleep(100);
    };
    /** What the page reported since the last look, attributed to the action being done. */
    const collect = (): void => {
      const e = page.events;
      for (const x of e.exceptions) note('exception', x);
      for (const x of e.consoleErrors) {
        // A request the browser refused (not on this computer) fails in the page's own words too: not the app's fault.
        if (run.blocked.size && /ERR_BLOCKED_BY_CLIENT|Failed to fetch|Failed to load resource|NetworkError/i.test(x)) continue;
        note('console', x);
      }
      for (const r of e.requests) {
        let path = r.url;
        try { path = new URL(r.url).pathname; } catch { /* keep the text */ }
        if (r.status !== null && r.status >= 500) note('server', `${r.method} ${path} → ${r.status}`, r.url);
        else if (r.error && !/ABORTED|BLOCKED_BY_CLIENT/.test(r.error) && /^(XHR|Fetch)$/.test(r.type)) note('network', `${r.method} ${path} failed (${r.error})`, r.url);
      }
      page.clearEvents();
    };
    const toStart = async (): Promise<void> => { await page.goto(startUrl, 30_000).catch(() => undefined); };

    await page.goto(startUrl, 45_000);
    collect();

    const click = async (target: string, double: boolean): Promise<boolean> => {
      const box = await page.evaluate<{ x: number; y: number } | null>(
        `(() => { const el = (${FIND_LITE})(${JSON.stringify(target)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`
      );
      if (!box) return false;
      if (o.phone) {
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      if (double) for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 2 });
      return true;
    };
    const press = async (key: 'Enter' | 'Escape'): Promise<void> => {
      const k = key === 'Enter' ? { key, code: key, windowsVirtualKeyCode: 13, text: '\r' } : { key, code: key, windowsVirtualKeyCode: 27 };
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
    };

    const total = o.script ? o.script.length : o.actions;
    for (let i = 0; i < total; i++) {
      if (o.signal?.aborted) { run.stopped = 'stopped by the person'; break; }
      if (Date.now() > o.deadline) { run.stopped = 'time budget used up'; break; }
      const href = (await page.evaluate<string>('location.href').catch(() => undefined)) ?? '';
      let sameOrigin = false;
      try { sameOrigin = new URL(href).origin === new URL(origin).origin; } catch { /* the tab is gone */ }
      if (sameOrigin && !run.pages.includes(href.split('#')[0]) && run.pages.length < 100) run.pages.push(href.split('#')[0]);
      let step: GremlinStep | undefined;
      if (o.script) {
        // Doing again what was recorded, in the same order: nothing is chosen, so nothing is left alone for looking destructive.
        step = o.script[i];
        if (step.goto !== undefined) { await toStart(); run.steps.push(step); continue; }
      } else {
        if (!sameOrigin) {
          // Wandered off the app (or the tab is gone): back to the start.
          await toStart();
          run.steps.push({ goto: home });
          continue;
        }
        const all = (await page.evaluate<Candidate[]>(CANDIDATES).catch(() => undefined)) ?? [];
        const usable = all.filter(c => {
          if (o.bold || c.kind === 'field' || !DESTRUCTIVE.test(c.label)) return true;
          if (!run.skipped.includes(c.label) && run.skipped.length < 30) run.skipped.push(c.label);
          return false;
        });
        const fields = usable.filter(c => c.kind === 'field');
        const submits = usable.filter(c => c.kind === 'submit');
        const clicks = usable.filter(c => c.kind !== 'field');
        const r = random();
        // Decided first, so a problem the action causes while it runs counts it among its steps.
        if (r < 0.22 && fields.length) { const field = pick(fields); step = { type: pick(JUNK), into: field.target }; }
        else if (r < 0.32 && submits.length) step = { click: pick(submits).target, double: true };
        else if (r < 0.37) step = { press: 'Enter' };
        else if (r < 0.42 && run.steps.length) step = { back: true };
        else if (r < 0.45) step = { press: 'Escape' };
        else if (clicks.length) step = { click: pick(clicks).target };
        else if (run.steps.length) step = { back: true };
      }
      if (!step) break;
      current = step;
      try {
        if (step.type !== undefined) {
          const found = await page.evaluate<boolean>(`(() => { const el = (${FIND_LITE})(${JSON.stringify(step.into)}); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`);
          if (o.script && !found) { run.missing++; current = undefined; continue; }
          await page.send('Input.insertText', { text: step.type });
        } else if (step.click) {
          if (!(await click(step.click, step.double === true))) { run.missing++; current = undefined; continue; }
        } else if (step.press) await press(step.press);
        else if (step.back) await page.evaluate('history.back()');
      } catch { current = undefined; continue; }
      await idle(2500);
      collect();
      run.steps.push(step);
      current = undefined;
      run.actions++;
      // The step is already among the steps: a problem it showed afterwards is noted without adding it again.
      if (await page.evaluate<boolean>(BLANK).catch(() => false)) {
        note('blank', 'The page went blank', href);
        if (!o.script) { await toStart(); run.steps.push({ goto: home }); }
      }
      const overlay = await page.evaluate<string>(OVERLAY).catch(() => '');
      if (overlay) note('overlay', overlay, href);
      o.say(`Gremlins: ${run.actions}/${total}`);
    }
  } finally { await page.close(); }
  return run;
}

/** The names a changed line may contain that a problem's text names: a path, or a quoted name. */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\s(\/[\w\-./]{3,})/g)) out.push(m[1].replace(/\/$/, ''));
  for (const m of text.matchAll(/['"“‘]([\w.$-]{3,40})['"”’]/g)) out.push(m[1]);
  return [...new Set(out)];
}

function anchorOf(net: FileDiff[], text: string): string | undefined {
  for (const t of tokensOf(text)) {
    const at = addedLineWith(net, t);
    if (at) return `${at.file}:${at.line}`;
  }
  return undefined;
}

/** A first page for a copy that is served as plain files: index.html, else the first HTML file at the top. */
function firstHtml(files: string[]): string {
  if (files.includes('index.html')) return '/';
  const f = files.find(n => /\.html?$/i.test(n));
  return f ? `/${f}` : '/';
}

const idOf = (key: string): string => `g-${sha(key, 8)}`;

interface RoundOpts { actions: number; seed: number; phone: boolean; bold: boolean; deadline: number; signal?: AbortSignal; say: (m: string) => void; session?: Session; script?: GremlinStep[] }

/** The app at an address that is running, or the project's own app started from a clean copy of a commit, and one round through it. */
async function inApp(browser: Browser, where: { repo: string; settings: ReturnType<typeof repoSettings>; url?: string; commit: string; label: 'head' | 'base'; page?: string }, o: RoundOpts): Promise<{ run: Round; start: string } | { error: string }> {
  if (where.url) {
    const u = new URL(where.url);
    const start = where.page ?? (u.pathname + u.search || '/');
    o.say(`Gremlins on ${where.url} (seed ${o.seed})…`);
    return { run: await round(browser, u.origin, start, o), start };
  }
  return withSide({ repo: where.repo }, where.commit, where.label, where.settings, o.say, async (origin, mode, dir) => {
    const start = where.page ?? where.settings.pages?.[0] ?? (mode === 'static' ? firstHtml(fs.readdirSync(dir)) : '/');
    o.say(where.label === 'head' ? `Gremlins on ${where.commit.slice(0, 7)} (seed ${o.seed})…` : `The same seed at ${where.commit.slice(0, 7)}…`);
    // A session is for the app that is running: a clean copy has its own data and nobody's session in it.
    return { run: await round(browser, origin, start, { ...o, session: undefined }), start };
  });
}

function needAllowed(repo: string): ReturnType<typeof repoSettings> {
  const settings = repoSettings(repo);
  if (!settings.allow) throw new Error('Running this repository’s app isn’t allowed yet. A person has to turn it on: assay allow-run');
  if (!settings.writes) throw new Error('Gremlins click and type, and a click can save and a text can be sent, so they are one of the checks that change data. A person has to turn that on: assay allow-run --writes');
  return settings;
}

export async function runGremlins(opts: GremlinsOptions): Promise<GremlinsReport> {
  const t0 = Date.now();
  const repo = repoRoot(opts.repo);
  const settings = needAllowed(repo);
  if (opts.url && opts.base) throw new Error('--base starts the app at two commits; with --url the app is the one that is already running. Give one or the other.');
  const url = opts.url ? checkUrl(opts.url) : undefined;
  const planned = Math.max(1, Math.min(300, Math.round(opts.actions ?? 40)));
  const seed = Number.isFinite(opts.seed) ? Math.abs(Math.trunc(opts.seed as number)) % 1_000_000_000 : Math.floor(Math.random() * 9000) + 1000;
  const say = opts.onProgress ?? ((): void => {});
  const commit = resolveRev(repo, opts.ref ?? 'HEAD');
  const base = opts.base ? resolveRev(repo, opts.base) : undefined;
  const page = opts.page ? checkPagePath(opts.page) : undefined;
  const exe = findBrowser(settings.browser);
  if (!exe) throw new Error('No Chromium-based browser (Chrome, Edge, Brave or Chromium) was found. Install one, or point at it: assay allow-run --browser <path>');
  const deadline = t0 + (opts.budgetSeconds ?? 300) * 1000;
  const session = url && (opts.session?.cookie || opts.session?.authorization) ? opts.session : undefined;
  const common: RoundOpts = { actions: planned, seed, phone: opts.phone === true, bold: opts.bold === true, signal: opts.signal, say, deadline, session };
  const notes: string[] = [];
  if (!url && (opts.session?.cookie || opts.session?.authorization)) notes.push('A session was given, but it is only used with --url: a clean copy of a commit has its own data and nobody’s session in it.');
  const browser = await Browser.launch(exe);
  let head: Round;
  let start = '/';
  let before: Round | undefined;
  let net: FileDiff[] = [];
  try {
    const first = await inApp(browser, { repo, settings, url, commit, label: 'head', page }, common);
    if ('error' in first) throw new Error(first.error);
    head = first.run;
    start = first.start;
    if (base) {
      net = commitDiff(repo, commit, base);
      const b = await inApp(browser, { repo, settings, commit: base, label: 'base', page }, { ...common, deadline: Math.max(deadline, Date.now() + 60_000) });
      if ('error' in b) notes.push(`The base couldn’t be started (${b.error.split('\n')[0].slice(0, 160)}), so everything seen at the head is reported, new or not.`);
      else before = b.run;
    }
  } finally { await browser.close(); }

  const findings: GremlinFinding[] = [];
  let old = 0;
  for (const [key, f] of head.found) {
    if (before?.found.has(key)) { old++; continue; }
    const k = KINDS[f.kind];
    findings.push({
      id: idOf(key), kind: f.kind, severity: k.sev, tier: tierOf([{ kind: 'probe', source: `gremlins:${f.kind}` }]), title: k.title, text: redactSecrets(f.text),
      count: f.count, step: f.step, url: f.url ? redactSecrets(f.url) : undefined, steps: f.steps, where: base ? anchorOf(net, f.text) : undefined, fix: k.fix
    });
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.step - b.step);
  if (before) notes.push(`The same seed was run at ${base!.slice(0, 7)}: ${old} problem${old === 1 ? '' : 's'} met there too, not counted. What the base does depends on its own pages, so a run is a sample, not a proof that nothing else is wrong.`);
  if (head.blocked.size) notes.push(`The browser refused to talk to ${[...head.blocked].slice(0, 6).join(', ')}: not on this computer.`);
  const flags = `${opts.phone ? ' --phone' : ''}${opts.bold ? ' --bold' : ''}${page ? ` --page ${page}` : ''}`;
  const replay = url
    ? `assay gremlins --url ${url} --seed ${seed} --actions ${planned}${flags}`
    : `assay gremlins --ref ${commit.slice(0, 7)}${base ? ` --base ${base.slice(0, 7)}` : ''} --seed ${seed} --actions ${planned}${flags}`;
  const report: GremlinsReport = {
    schema: GREMLINS_SCHEMA, id: newRunId(repo, commit, seed), repo, name: repoName(repo), commit, base, mode: url ? 'running' : 'copy', url, seed, planned, actions: head.actions, phone: opts.phone === true, bold: opts.bold === true,
    browser: exe.split(/[\\/]/).pop() ?? 'browser', findings, before: old, pages: head.pages.map(p => redactSecrets(p)), skipped: head.skipped, blocked: [...head.blocked], notes, replay, start,
    signedIn: !!session, trail: head.steps, previous: null, gone: [], secs: Math.round((Date.now() - t0) / 1000), stopped: head.stopped, createdAt: new Date().toISOString()
  };
  compareRuns(report);
  if (opts.save !== false) keepRun(report);
  return report;
}

export interface GremlinsReplay {
  /** The kept run, and the problem that was gone after. */
  run: string;
  finding: { id: string; kind: GremlinKind; title: string; text: string; step: number };
  /** Whether the same problem showed again. */
  reproduced: boolean;
  /** How many of the recorded steps were done, and how many couldn't be (an element that wasn't there). */
  done: number;
  missing: number;
  /** Everything the replay saw. */
  seen: Array<{ id: string; kind: GremlinKind; text: string }>;
  /** Where it ran: the address, or the commit started from a clean copy. */
  where: string;
  notes: string[];
}

export interface GremlinsReplayOptions {
  repo: string;
  /** A kept run: its id, or the start of one. */
  run: string;
  /** The problem to reproduce: its id (`g-…`). Default: the run's first problem. */
  finding?: string;
  /** Replay a running app at another address (its port may have changed). */
  url?: string;
  session?: Session;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}

/** Does again, exactly and in order, the steps a kept run recorded up to a problem, and says whether the problem came back. Nothing is saved. */
export async function replayGremlins(opts: GremlinsReplayOptions): Promise<GremlinsReplay> {
  const t0 = Date.now();
  const repo = repoRoot(opts.repo);
  const settings = needAllowed(repo);
  const rec = loadGremlinRun(repo, opts.run);
  if (!rec) throw new Error(`There is no kept run "${opts.run}" for this project. assay gremlins list shows them.`);
  const f = opts.finding ? rec.findings.find(x => x.id === opts.finding || x.id.startsWith(opts.finding as string)) : rec.findings[0];
  if (!f) throw new Error(opts.finding ? `That run has no problem "${opts.finding}".` : 'That run found nothing to reproduce.');
  const script = rec.trail.slice(0, f.step);
  if (!script.length) throw new Error('That run didn’t keep the steps (it was made by an older Assay). Run it again.');
  const exe = findBrowser(settings.browser);
  if (!exe) throw new Error('No Chromium-based browser (Chrome, Edge, Brave or Chromium) was found. Install one, or point at it: assay allow-run --browser <path>');
  const url = rec.mode === 'running' ? checkUrl(opts.url ?? rec.url ?? '') : undefined;
  if (rec.mode === 'copy' && opts.url) throw new Error('That run started the app from a clean copy of a commit; --url is only for a run that went through an app that was running.');
  const session = url && (opts.session?.cookie || opts.session?.authorization) ? opts.session : undefined;
  const notes: string[] = [];
  if (rec.signedIn && !session) notes.push('That run was signed in and this one is not (no session in the environment), so a page behind a login will show its login.');
  const say = opts.onProgress ?? ((): void => {});
  const browser = await Browser.launch(exe);
  let res: { run: Round; start: string } | { error: string };
  try {
    res = await inApp(browser, { repo, settings, url, commit: resolveRev(repo, rec.commit), label: 'head', page: rec.start }, { actions: script.length, seed: rec.seed, phone: rec.phone, bold: true, deadline: t0 + 300_000, signal: opts.signal, say, session, script });
  } finally { await browser.close(); }
  if ('error' in res) throw new Error(res.error);
  const seen = [...res.run.found.entries()].map(([key, r]) => ({ id: idOf(key), kind: r.kind, text: redactSecrets(r.text) }));
  if (res.run.missing) notes.push(`${res.run.missing} of the ${script.length} steps could not be done (what they clicked or typed into wasn’t on the page), so the app has changed since or answered differently.`);
  return {
    run: rec.id, finding: { id: f.id, kind: f.kind, title: f.title, text: f.text, step: f.step }, reproduced: seen.some(x => x.id === f.id),
    done: res.run.actions, missing: res.run.missing, seen, where: url ?? `a clean copy of ${rec.commit.slice(0, 7)}`, notes
  };
}

const RANK: Record<GremlinSeverity, number> = { high: 0, medium: 1, low: 2 };

/** True when a proven finding is at least this serious (for --fail-on). */
export function gremlinsFail(r: GremlinsReport, on: GremlinSeverity): boolean {
  return r.findings.some(f => f.tier === 'proven' && RANK[f.severity] <= RANK[on]);
}
