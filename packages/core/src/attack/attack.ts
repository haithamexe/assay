import crypto from 'node:crypto';
import { Browser } from '../browser/cdp.js';
import { findBrowser } from '../browser/find.js';
import { redactSecrets } from '../checks/secrets.js';
import { sha } from '../config.js';
import { tierOf } from '../evidence.js';
import { repoName, repoRoot, resolveRev } from '../git.js';
import { checkUrl, type BodyField, type EndpointEntry } from '../project/inputs.js';
import { runCheckup } from '../project/checkup.js';
import { repoSettings } from '../proof/settings.js';
import type { Tier } from '../types.js';

/**
 * Attack my app (D64): a friendly security pass on a project's own app, on this computer only, taken over from a sister tool.
 * Assay never starts the app: the person gives the address of one that is running (`url`, loopback only), and the endpoints come
 * from what Assay can read without running anything: the repository's router files and OpenAPI file, a HAR, and a list of pages.
 *
 * Reads (GET only, always): security headers, the flags of every cookie the app sets, CORS from another origin, calls that answer
 * without the session, other ids, stack traces and SQL errors after a quote, script in the address that comes back unescaped
 * (and, in a browser, becomes an element). Writes (`writes`, and the person's own `assay allow-run --writes`): script saved
 * through a form, a write sent as another site would send it (CSRF), twenty wrong passwords in a row, malformed bodies.
 * A body is built from the OpenAPI file's property names and types and test values, never from a recorded body.
 *
 * Every request goes to the given origin and nowhere else; redirects are not followed. A session (a cookie or an Authorization value)
 * is used for the run only and is in no report, log or answer.
 */

export const ATTACK_SCHEMA = 'assay.attack/1';
export type AttackSeverity = 'high' | 'medium' | 'low';
export type AttackCheck = 'xss-reflected' | 'xss-stored' | 'idor' | 'no-auth' | 'csrf' | 'cors' | 'cookie' | 'headers' | 'stack-trace' | 'sql-error' | 'login-rate';

export interface AttackFinding {
  id: string;
  check: AttackCheck;
  severity: AttackSeverity;
  /** proven: the request shows it whatever was meant. hint: it depends on what was meant (is that endpoint meant to be public? does that record belong to this user?). Computed from the evidence. */
  tier: Tier;
  title: string;
  /** Why it matters and what to do. */
  fix: string;
  /** The request that shows it, secrets masked: "GET /api/orders/2 → 200". */
  proof: string;
  /** The file that declares the route, when Assay read one. */
  where?: string;
}

export interface AttackReport {
  schema: typeof ATTACK_SCHEMA;
  repo: string;
  name: string;
  /** The commit the endpoints were read from. The app at the address is whatever is running now. */
  commit: string;
  url: string;
  /** Whether the checks that change data were allowed and run. */
  writes: boolean;
  findings: AttackFinding[];
  /** What was tried, and how often. */
  tried: string[];
  /** What was not tried, and why. */
  skipped: string[];
  requests: number;
  secs: number;
  createdAt: string;
}

export interface AttackOptions {
  repo: string;
  /** The app on this computer: http://localhost:3000. Required. */
  url: string;
  ref?: string;
  pages?: string[];
  har?: string;
  flow?: string;
  openapi?: string;
  /** Also run the checks that change data. Needs `assay allow-run --writes`. */
  writes?: boolean;
  /** A signed-in session to test signed-in calls with; used for this run only. */
  session?: { cookie?: string; authorization?: string };
  /** Confirm script in a real browser. Default: when one is found. */
  browser?: boolean;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}

const EVIL = 'https://evil.example';
const LOGIN = /\/(login|log-in|signin|sign-in|session|sessions|authenticate|auth\/(token|login|signin|callback\/credentials)|oauth\/token|token)\b/i;
/** A GET that does something when it is only asked: never sent. */
const SIDE_EFFECT = /(log-?out|sign-?out|delete|remove|destroy|reset|unsubscribe|revoke|cancel|disable|clear|purge|wipe)/i;
const STACK = [/\n\s+at [^\n]+\([^\n)]+:\d+:\d+\)/, /Traceback \(most recent call last\)/, /\bFile "[^"]+", line \d+/, /[\\/]node_modules[\\/]/, /\bat [\w.<>]+ \((?:file:\/\/)?[A-Za-z]?:?[\\/][^)]+\)/, /Exception in thread|java\.lang\.|System\.\w+Exception/];
const SQL = /SQLSTATE|syntax error at or near|SQLITE_ERROR|ER_PARSE_ERROR|You have an error in your SQL syntax|unterminated quoted string|PrismaClientKnownRequestError|QueryFailedError/i;
const MAX_BODY = 256 * 1024;
const MAX_FINDINGS = 100;

/** A path with its parameters filled in: {id} becomes `fill`. */
const fillPath = (p: string, fill: string): string => p.replace(/\{[^}]*\}/g, fill);
const hasParam = (p: string): boolean => /\{[^}]*\}/.test(p);

/** A test value for a body field, by its type and what its name says. */
function sample(f: BodyField): unknown {
  switch (f.type) {
    case 'integer': case 'number': return 1;
    case 'boolean': return true;
    case 'array': return [];
    case 'object': return {};
    default: {
      const n = f.name.toLowerCase();
      if (/e-?mail/.test(n)) return 'assay-test@example.com';
      if (/pass/.test(n)) return 'Assay-test-1234';
      if (/url|link|website|href/.test(n)) return 'https://example.com';
      if (/phone|tel/.test(n)) return '5550100';
      if (/date|time/.test(n)) return '2026-01-01';
      return 'assay test';
    }
  }
}

/** A body for an endpoint from its fields: the required ones, the first string ones, and the marker in up to three free-text fields. */
function bodyFor(fields: BodyField[], mark?: string): { body: string; marked: number } {
  const doc: Record<string, unknown> = {};
  let marked = 0;
  for (const f of fields) {
    if (!f.required && Object.keys(doc).length >= 6) continue;
    let v = sample(f);
    if (mark && f.type === 'string' && marked < 3 && !/e-?mail|pass|url|link|website|href|phone|tel|date|time|id$|uuid|token|code/i.test(f.name)) { v = `${v} ${mark}`; marked++; }
    doc[f.name] = v;
  }
  return { body: JSON.stringify(doc), marked };
}

interface Sent { status: number; headers: Headers; body: string }

export async function runAttack(opts: AttackOptions): Promise<AttackReport> {
  const t0 = Date.now();
  const repo = repoRoot(opts.repo);
  const settings = repoSettings(repo);
  if (!settings.allow) throw new Error('Running this repository’s app checks isn’t allowed yet. A person has to turn it on: assay allow-run');
  if (opts.writes && !settings.writes) throw new Error('Sending requests that change data isn’t allowed yet. A person has to turn it on: assay allow-run --writes  (without --writes, assay attack only reads).');
  const url = checkUrl(opts.url);
  const base = new URL(url);
  const writes = opts.writes === true;
  const say = opts.onProgress ?? ((): void => {});
  const session = opts.session ?? {};
  const hasSession = !!(session.cookie || session.authorization);
  const sessionHeaders = (): Record<string, string> => ({ ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.authorization ? { authorization: session.authorization } : {}) });

  // What the project says it has: read from git and the files given, nothing run.
  const commit = resolveRev(repo, opts.ref ?? 'HEAD');
  const cu = runCheckup({ repo, ref: commit, url, pages: opts.pages, har: opts.har, flow: opts.flow, openapi: opts.openapi, checks: [], inventory: true, save: false, bodies: true });
  const endpoints: EndpointEntry[] = cu.inventory?.endpoints ?? [];
  const pageList = [...new Set((cu.inventory?.pages ?? []).map(p => fillPath(p.path, '1')))].slice(0, 8);
  if (!pageList.length) pageList.push('/');

  const report: AttackReport = { schema: ATTACK_SCHEMA, repo, name: repoName(repo), commit, url, writes, findings: [], tried: [], skipped: [], requests: 0, secs: 0, createdAt: new Date().toISOString() };
  const found = new Set<string>();
  const add = (f: Omit<AttackFinding, 'id' | 'tier'>, kind: 'probe' | 'rule'): void => {
    const key = `${f.check} ${f.title}`;
    if (found.has(key) || report.findings.length >= MAX_FINDINGS) return;
    found.add(key);
    const proof = redactSecrets(f.proof);
    report.findings.push({ ...f, proof, id: `a-${sha(key, 8)}`, tier: tierOf([{ kind, source: `attack:${f.check}` }]) });
  };

  const send = async (method: string, pathAndQuery: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Sent | undefined> => {
    if (opts.signal?.aborted) return undefined;
    const target = new URL(pathAndQuery, base);
    // One origin only: a path can't lead anywhere else.
    if (target.origin !== base.origin) return undefined;
    report.requests++;
    try {
      const res = await fetch(target, { method, headers: { 'user-agent': 'assay-attack', ...init.headers }, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      return { status: res.status, headers: res.headers, body: (await res.text()).slice(0, MAX_BODY) };
    } catch { return undefined; }
  };

  const route = (method: string, p: string): string | undefined => endpoints.find(e => (e.method === method || e.method === '*') && e.path === p)?.file;
  const gets = endpoints.filter(e => (e.method === 'GET' || e.method === '*') && !SIDE_EFFECT.test(e.path));
  const skippedGets = endpoints.filter(e => (e.method === 'GET' || e.method === '*') && SIDE_EFFECT.test(e.path));
  const posts = endpoints.filter(e => ['POST', 'PUT', 'PATCH'].includes(e.method) && !LOGIN.test(e.path) && !SIDE_EFFECT.test(e.path));
  const getUrls = gets.slice(0, 40).map(e => ({ e, p: fillPath(e.path, '1') }));
  if (!endpoints.length) report.skipped.push('API checks: no endpoint was found. Give an OpenAPI file (--openapi), a HAR (--har), or run in a project whose routers Assay can read.');
  if (skippedGets.length) report.skipped.push(`${skippedGets.length} GET endpoint${skippedGets.length === 1 ? '' : 's'} not sent (the name says it does something: ${skippedGets.slice(0, 3).map(e => e.path).join(', ')})`);
  if (endpoints.some(e => e.from.length === 1 && e.from[0] === 'code')) report.skipped.push('Routes read from code are as each file writes them: a prefix they are mounted under elsewhere is not known, so some requests may answer 404.');

  // ---- security headers, on the first page
  say('Security headers');
  const home = await send('GET', pageList[0], { headers: { accept: 'text/html' } });
  const seenCookies = new Map<string, string>();
  const takeCookies = (r: Sent | undefined): void => {
    for (const c of r?.headers.getSetCookie?.() ?? []) { const name = c.split('=')[0].trim(); if (name && !seenCookies.has(name)) seenCookies.set(name, c.replace(/^([^=]+)=[^;]*/, '$1=•••')); }
  };
  takeCookies(home);
  if (home) {
    report.tried.push(`security headers on ${pageList[0]}`);
    const h = home.headers;
    const csp = h.get('content-security-policy') ?? '';
    const missing: string[] = [];
    if (!csp) missing.push('Content-Security-Policy (limits where scripts can come from, the main defence against injected script)');
    if (!/frame-ancestors/i.test(csp) && !h.get('x-frame-options')) missing.push('X-Frame-Options or frame-ancestors (stops other sites framing the app to trick clicks)');
    if ((h.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
    if (!h.get('referrer-policy')) missing.push('Referrer-Policy');
    if (missing.length) add({ check: 'headers', severity: 'low', title: `${missing.length} security header${missing.length === 1 ? '' : 's'} missing`, fix: `Add ${missing.join('; ')}. In Express, helmet() sets them; in Next.js, headers() in next.config. Many apps add them only in production: check that it does.`, proof: `GET ${pageList[0]} → ${home.status}, without ${missing.map(m => m.split(' ')[0]).join(', ')}` }, 'probe');
  } else report.skipped.push(`Nothing answered at ${url}${pageList[0]}. Is the app running at that address?`);

  // ---- CORS: what another site's page is allowed to read
  say('CORS');
  let corsTried = 0;
  for (const { e, p } of getUrls.slice(0, 6)) {
    const r = await send('GET', p, { headers: { origin: EVIL, accept: 'application/json', ...sessionHeaders() } });
    takeCookies(r);
    if (!r) continue;
    corsTried++;
    const allow = r.headers.get('access-control-allow-origin');
    const creds = (r.headers.get('access-control-allow-credentials') ?? '').toLowerCase() === 'true';
    if (allow === EVIL && creds) add({ check: 'cors', severity: 'high', title: `Any site can read ${e.path} with the user's cookies`, fix: 'The server copies the Origin header into Access-Control-Allow-Origin and allows credentials. Allow only your own front end’s origins, from a fixed list.', proof: `GET ${p} with Origin: ${EVIL} → Access-Control-Allow-Origin: ${allow}, Allow-Credentials: true`, where: e.file }, 'probe');
    else if (allow === EVIL) add({ check: 'cors', severity: 'medium', title: 'CORS allows whichever site asks', fix: 'Access-Control-Allow-Origin echoes the Origin header. List the origins allowed instead.', proof: `GET ${p} with Origin: ${EVIL} → Access-Control-Allow-Origin: ${allow}`, where: e.file }, 'probe');
  }
  if (corsTried) report.tried.push(`CORS on ${corsTried} endpoint${corsTried === 1 ? '' : 's'}`);

  // ---- calls that answer without the session, and other ids
  if (hasSession) {
    say('Signed-in calls without the session');
    let authTried = 0;
    for (const { e, p } of getUrls.slice(0, 8)) {
      const withSession = await send('GET', p, { headers: { accept: 'application/json', ...sessionHeaders() } });
      if (!withSession || withSession.status < 200 || withSession.status >= 300) continue;
      const without = await send('GET', p, { headers: { accept: 'application/json' } });
      if (!without) continue;
      authTried++;
      if (without.status >= 200 && without.status < 300 && without.body.length > 2 && !/^\s*(\[\]|\{\}|null)\s*$/.test(without.body) && without.body === withSession.body)
        add({ check: 'no-auth', severity: 'high', title: `${e.path} answers without signing in`, fix: 'It answers the same with and without the session. If it should be private, check the route requires a session (a middleware it skips, or one that lets unknown users through). If it is public, ignore this.', proof: `GET ${p} without Cookie or Authorization → ${without.status}, the same answer as signed in`, where: e.file }, 'rule');
    }
    if (authTried) report.tried.push(`${authTried} endpoint${authTried === 1 ? '' : 's'} with and without the session`);
    say('Other ids');
    let idTried = 0;
    for (const e of gets.filter(x => hasParam(x.path)).slice(0, 6)) {
      const seen: Array<{ id: string; body: string }> = [];
      for (const id of ['1', '2', '3']) {
        const r = await send('GET', fillPath(e.path, id), { headers: { accept: 'application/json', ...sessionHeaders() } });
        if (r && r.status >= 200 && r.status < 300 && r.body.length > 2) seen.push({ id, body: r.body });
      }
      idTried++;
      if (new Set(seen.map(s => s.body)).size >= 2)
        add({ check: 'idor', severity: 'medium', title: `Changing the id in ${e.path} opens other records`, fix: `With your session, ids ${seen.map(s => s.id).join(', ')} all answer with different records. If any of them belongs to someone else, the route must check it is the signed-in user’s (where owner = session user), not only that the id exists. If they are all yours or all public, ignore this.`, proof: `GET ${fillPath(e.path, seen[1].id)} with your session → 200, a different record from ${fillPath(e.path, seen[0].id)}`, where: e.file }, 'rule');
    }
    if (idTried) report.tried.push(`other ids on ${idTried} endpoint${idTried === 1 ? '' : 's'}`);
  } else report.skipped.push('Signed-in calls and other ids (no-auth, IDOR) and CSRF: give a session in ASSAY_SESSION_COOKIE or ASSAY_SESSION_AUTHORIZATION (ASSAY_ATTACK_COOKIE and ASSAY_ATTACK_AUTHORIZATION work too) (a value from your browser) to test them.');

  // ---- stack traces and SQL errors after a quote (GET), and after a broken body (writes)
  say('Error answers');
  let errTried = 0;
  const probe = async (method: string, p: string, body: string | undefined, where: string | undefined, title: string): Promise<void> => {
    const r = await send(method, p, { headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...sessionHeaders() }, body });
    takeCookies(r);
    if (!r) return;
    errTried++;
    const sql = SQL.exec(r.body);
    if (sql) add({ check: 'sql-error', severity: 'high', title: `A quote in ${title} reaches the database as SQL`, fix: 'The answer shows a SQL error after one quote, so the value is put into the query text. Use the driver’s parameters (or the ORM) for every value, never string building.', proof: `${method} ${p} → ${r.status}: ${sql[0].slice(0, 80)}`, where }, 'probe');
    else if (STACK.some(x => x.test(r.body))) add({ check: 'stack-trace', severity: 'medium', title: `${title} answers an error with its stack trace`, fix: 'Files, lines and libraries tell an attacker how the server is built. Answer a short message and log the details; check NODE_ENV=production (or DEBUG=False) hides them.', proof: `${method} ${p}${body ? ` with a broken body` : ''} → ${r.status}, with a stack trace`, where }, 'probe');
  };
  for (const { e } of getUrls.slice(0, 10)) {
    const p = hasParam(e.path) ? `${fillPath(e.path, "1'")}` : `${e.path}?q=%27&id=1%27&search=%27`;
    await probe('GET', p.replace(/'/g, '%27'), undefined, e.file, e.path);
  }
  if (writes) for (const e of posts.slice(0, 6)) await probe(e.method, fillPath(e.path, '1'), '{"assay": ', e.file, e.path);
  if (errTried) report.tried.push(`malformed input on ${errTried} call${errTried === 1 ? '' : 's'}`);

  // ---- script that comes back unescaped, in the address
  const marker = `assay${crypto.randomBytes(4).toString('hex')}`;
  const tag = `<${marker} data-assay-xss="1"></${marker}>`;
  const payload = `"'>${tag}`;
  const reflect = [...new Set([...pageList.slice(0, 4), ...getUrls.filter(x => /\.html?$|\/$/.test(x.p)).slice(0, 2).map(x => x.p)])]
    .map(p => { const u = new URL(p, base); for (const k of ['q', 'query', 'search', 'name']) if (!u.searchParams.has(k)) u.searchParams.set(k, payload); for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, payload); return u.pathname + u.search; });
  say('Script in the address');
  for (const p of reflect) {
    const r = await send('GET', p, { headers: { accept: 'text/html', ...sessionHeaders() } });
    takeCookies(r);
    if (r && /text\/html/i.test(r.headers.get('content-type') ?? '') && r.body.includes(tag))
      add({ check: 'xss-reflected', severity: 'high', title: `${p.split('?')[0]} puts the address into the page unescaped`, fix: 'A value from the query string comes back as HTML, so a link can run script on the app. Escape it (your template engine’s default output, not its raw one).', proof: `GET ${p.split('?')[0]}?… → the page contains ${tag}`, where: route('GET', p.split('?')[0]) }, 'probe');
  }
  report.tried.push(`script in the address on ${reflect.length} page${reflect.length === 1 ? '' : 's'}`);

  // ---- writes: script saved through a form, CSRF, wrong passwords
  let stored = 0;
  const forms = posts.filter(e => e.body?.some(f => f.type === 'string')).slice(0, 4);
  if (writes) {
    say('Script saved through the app’s own forms');
    for (const e of forms) {
      const { body, marked } = bodyFor(e.body!, tag);
      if (!marked) continue;
      const r = await send(e.method, fillPath(e.path, '1'), { headers: { 'content-type': 'application/json', accept: 'application/json', ...sessionHeaders() }, body });
      takeCookies(r);
      if (r && r.status < 400) stored++;
    }
    if (stored) report.tried.push(`script saved through ${stored} form${stored === 1 ? '' : 's'}`);
    else if (forms.length) report.skipped.push('Script saved through forms: none of the forms accepted the test body (the OpenAPI file may not describe it fully).');
    else report.skipped.push('Script saved through forms: no POST, PUT or PATCH with a described text body was found (an OpenAPI file lists them).');
  } else report.skipped.push('Script saved through forms, CSRF, wrong passwords and malformed bodies: they send data, so they need --writes (a person runs assay allow-run --writes first).');

  // The same script, and the one in the address, in a real browser: did the marker become an element?
  const exe = (opts.browser ?? true) ? findBrowser(settings.browser) : null;
  if (exe && (stored || reflect.length)) {
    say('Loading the pages in a headless browser');
    let browser: Awaited<ReturnType<typeof Browser.launch>> | null = null;
    try {
      browser = await Browser.launch(exe);
      const page = await browser.newPage();
      if (session.cookie) for (const part of session.cookie.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0) await page.send('Network.setCookie', { name: part.slice(0, i), value: part.slice(i + 1), url: base.origin }).catch(() => undefined); }
      const targets = [...(stored ? pageList.slice(0, 4).map(p => ({ p, how: 'stored' as const })) : []), ...reflect.map(p => ({ p, how: 'reflected' as const }))];
      for (const t of targets) {
        if (opts.signal?.aborted) break;
        try { await page.goto(new URL(t.p, base).href); } catch { continue; }
        const hit = await page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(`${marker}[data-assay-xss]`)})`).catch(() => false);
        if (!hit) continue;
        if (t.how === 'reflected') add({ check: 'xss-reflected', severity: 'high', title: `${t.p.split('?')[0]} turns the address into HTML in the browser`, fix: 'The page’s own script puts a value from the address into the page as HTML (innerHTML, dangerouslySetInnerHTML, v-html). Set it as text instead.', proof: `${t.p.split('?')[0]}?… → the page has an element <${marker}> made from the address`, where: route('GET', t.p.split('?')[0]) }, 'probe');
        else add({ check: 'xss-stored', severity: 'high', title: `Text saved through the app shows up as HTML on ${t.p}`, fix: 'A value saved with a form comes back as markup, so one user can run script in another’s browser. Render it as text (no innerHTML / dangerouslySetInnerHTML / v-html / |safe), or sanitise it.', proof: `${forms.slice(0, 2).map(f => `${f.method} ${f.path}`).join(', ')} with ${tag}, then ${t.p} has that element`, where: forms[0]?.file }, 'probe');
      }
    } catch (err) {
      report.skipped.push(`Script in the page: ${(err as Error).message.split('\n')[0]}`);
    } finally { await browser?.close().catch(() => undefined); }
  } else if (!exe && (opts.browser ?? true)) report.skipped.push('Script in the page, in a real browser: no Chrome, Edge, Brave or Chromium was found.');

  if (writes && session.cookie) {
    say('Writes from another site (CSRF)');
    let csrfTried = 0;
    for (const e of posts.filter(x => x.body).slice(0, 3)) {
      const p = fillPath(e.path, '1');
      const { body } = bodyFor(e.body!);
      // Only a write that needs the session can be forged with it: one that works without it isn't about a cookie.
      const open = await send(e.method, p, { headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
      if (!open || (open.status >= 200 && open.status < 300)) continue;
      const r = await send(e.method, p, { headers: { 'content-type': 'application/json', origin: EVIL, referer: `${EVIL}/`, cookie: session.cookie }, body });
      if (!r) continue;
      csrfTried++;
      if (r.status >= 200 && r.status < 300) add({ check: 'csrf', severity: 'high', title: `${e.method} ${e.path} accepts a request from another site`, fix: 'With the user’s cookie and Origin: another site, it still did what it was asked. Check the Origin header, require a CSRF token, or set the session cookie SameSite=Lax/Strict.', proof: `${e.method} ${p} with Origin: ${EVIL} and the session cookie, no CSRF token → ${r.status} (without the cookie: ${open.status})`, where: e.file }, 'probe');
    }
    if (csrfTried) report.tried.push(`CSRF on ${csrfTried} write${csrfTried === 1 ? '' : 's'}`);
  } else if (writes) report.skipped.push('CSRF: give a session cookie in ASSAY_SESSION_COOKIE (or ASSAY_ATTACK_COOKIE).');

  const login = endpoints.find(e => e.method === 'POST' && LOGIN.test(e.path));
  if (writes && login) {
    say('Wrong passwords in a row');
    const p = fillPath(login.path, '1');
    const idField = login.body?.find(f => /e-?mail|user|login/i.test(f.name))?.name ?? 'email';
    const pwField = login.body?.find(f => /pass/i.test(f.name))?.name ?? 'password';
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await send('POST', p, { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ [idField]: 'nobody@example.com', [pwField]: `assay-wrong-${crypto.randomBytes(6).toString('hex')}` }) });
      if (!r) break;
      statuses.push(r.status);
      if (r.status === 429 || r.status === 423 || r.headers.get('retry-after')) break;
    }
    if (statuses.length) report.tried.push(`${statuses.length} wrong password${statuses.length === 1 ? '' : 's'} on ${p}`);
    if (statuses.length >= 20 && !statuses.some(s => s === 429 || s === 423)) add({ check: 'login-rate', severity: 'medium', title: `${login.path} took 20 wrong passwords in a row`, fix: 'Nothing slowed it down or locked it, so passwords can be guessed by trying. Limit attempts per account and per address (express-rate-limit, a 429 with Retry-After), and add a delay or lockout.', proof: `20 × POST ${p} with wrong passwords → ${[...new Set(statuses)].join(', ')}, no 429`, where: login.file }, 'probe');
  } else if (writes) report.skipped.push('Wrong passwords: no sign-in endpoint was found.');

  // ---- cookies the app set in answers to these requests: their flags, never their values
  if (seenCookies.size) report.tried.push(`flags of ${seenCookies.size} cookie${seenCookies.size === 1 ? '' : 's'}`);
  for (const [name, c] of seenCookies) {
    const lacks = [!/;\s*httponly/i.test(c) && /sess|sid|auth|token|jwt|login/i.test(name) ? 'HttpOnly (page scripts, and injected ones, can read it)' : '', !/;\s*samesite=(lax|strict)/i.test(c) ? 'SameSite=Lax (other sites can send it along)' : ''].filter(Boolean);
    if (lacks.length) add({ check: 'cookie', severity: /HttpOnly/.test(lacks[0]) ? 'medium' : 'low', title: `The ${name} cookie has no ${lacks.map(l => l.split(' ')[0]).join(' or ')}`, fix: `Set it with ${lacks.join(' and ')}, and Secure in production.`, proof: `Set-Cookie: ${c}` }, 'probe');
  }

  const order: Record<AttackSeverity, number> = { high: 0, medium: 1, low: 2 };
  report.findings.sort((a, b) => order[a.severity] - order[b.severity] || Number(b.tier === 'proven') - Number(a.tier === 'proven'));
  report.secs = Math.round((Date.now() - t0) / 100) / 10;
  return report;
}

/** Whether a report has a proven finding at or above a severity: the exit code of `assay attack --fail-on`. */
export function attackFails(r: AttackReport, on: AttackSeverity): boolean {
  const rank: Record<AttackSeverity, number> = { high: 3, medium: 2, low: 1 };
  return r.findings.some(f => f.tier === 'proven' && rank[f.severity] >= rank[on]);
}
