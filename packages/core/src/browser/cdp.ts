import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { assayPath } from '../config.js';
import { killTree } from '../proof/runner.js';

/**
 * A DevTools client written for this tool, over the browser's own pipe (--remote-debugging-pipe): no port is opened,
 * nothing is installed, and no automation library is involved. Messages are JSON, each ended by a NUL byte.
 */
type Params = Record<string, unknown>;
type Handler = (params: any, sessionId?: string) => void;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class Cdp {
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private handlers = new Map<string, Set<Handler>>();
  closed = false;

  constructor(private out: Writable, input: Readable) {
    let buf = Buffer.alloc(0);
    input.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0)) {
        const msg = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 1);
        this.dispatch(msg);
      }
    });
    input.on('close', () => this.fail(new Error('the browser closed')));
  }

  private dispatch(raw: string): void {
    let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result ?? {});
    } else if (m.method) for (const h of this.handlers.get(m.method) ?? []) h(m.params, m.sessionId);
  }

  private fail(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.rej(err);
    this.pending.clear();
  }

  send(method: string, params: Params = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('the browser closed'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(event: string, h: Handler): () => void {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(h);
    this.handlers.set(event, set);
    return () => set.delete(h);
  }
}

export interface PageEvents {
  exceptions: string[];
  consoleErrors: string[];
  /** Same-origin requests that failed or answered 4xx/5xx. */
  failed: Array<{ url: string; status: number | null; text: string }>;
}

export class Page {
  events: PageEvents = { exceptions: [], consoleErrors: [], failed: [] };
  /** The status the page's own document answered with, once it has. */
  docStatus: number | null = null;
  private off: Array<() => void> = [];

  constructor(readonly cdp: Cdp, readonly sessionId: string, readonly targetId: string) {
    const mine = (h: Handler): Handler => (p, sid) => { if (sid === this.sessionId) h(p, sid); };
    this.off.push(
      cdp.on('Runtime.exceptionThrown', mine(p => { this.events.exceptions.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 300)); })),
      cdp.on('Runtime.consoleAPICalled', mine(p => { if (p.type === 'error') this.events.consoleErrors.push((p.args ?? []).map((a: { value?: unknown; description?: string }) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300)); })),
      cdp.on('Network.responseReceived', mine(p => { if (p.type === 'Document' && this.docStatus === null) this.docStatus = Number(p.response?.status ?? 0); if (p.response?.status >= 400) this.events.failed.push({ url: String(p.response.url), status: p.response.status, text: String(p.response.statusText ?? '') }); })),
      cdp.on('Network.loadingFailed', mine(p => { if (!p.canceled && p.errorText !== 'net::ERR_ABORTED') this.events.failed.push({ url: String(p.requestId), status: null, text: String(p.errorText) }); }))
    );
  }

  send(method: string, params: Params = {}, timeoutMs?: number): Promise<any> { return this.cdp.send(method, params, this.sessionId, timeoutMs); }

  async init(): Promise<void> {
    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable'), this.send('Network.enable'), this.send('Log.enable')]);
    // Two servers can get the same port one after the other (base, then head): a cached stylesheet would show the wrong commit.
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
  }
  viewport(width: number, height: number, mobile: boolean): Promise<unknown> {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }
  scheme(value: 'light' | 'dark'): Promise<unknown> {
    return this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  }
  clearEvents(): void { this.events = { exceptions: [], consoleErrors: [], failed: [] }; this.docStatus = null; }

  async goto(url: string, timeoutMs = 20_000): Promise<void> {
    let done!: () => void;
    const loaded = new Promise<void>(r => { done = r; });
    const off = this.cdp.on('Page.loadEventFired', (_p, sid) => { if (sid === this.sessionId) done(); });
    try {
      const r = await this.send('Page.navigate', { url }, timeoutMs);
      if (r.errorText) throw new Error(`${url}: ${r.errorText}`);
      await Promise.race([loaded, sleep(timeoutMs).then(() => { throw new Error(`${url} did not finish loading in ${Math.round(timeoutMs / 1000)} s`); })]);
    } finally { off(); }
    await this.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
    await sleep(250);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
    return r.result?.value as T;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(String(r.data), 'base64');
  }

  async close(): Promise<void> {
    for (const o of this.off) o();
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000); } catch { /* the browser is closing anyway */ }
  }
}

/**
 * Linux only. A container's small shared memory makes the browser crash, so it keeps it in /tmp; and a browser started as root (a container, a CI job
 * run as root) refuses to start with its sandbox on. Assay only opens pages of the project under review, on a loopback address it started itself.
 */
function linuxFlags(): string[] {
  if (process.platform !== 'linux') return [];
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  return ['--disable-dev-shm-usage', '--disable-gpu', ...(root ? ['--no-sandbox'] : [])];
}

export class Browser {
  private constructor(private proc: ChildProcess, readonly cdp: Cdp, private dir: string) {}

  static async launch(exe: string): Promise<Browser> {
    const dir = assayPath('work', `browser-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const proc = spawn(exe, [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--disable-features=Translate,MediaRouter', ...linuxFlags(), 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
    const b = new Browser(proc, cdp, dir);
    try { await cdp.send('Browser.getVersion', {}, undefined, 20_000); } catch (e) { await b.close(); throw new Error(`The browser did not start: ${(e as Error).message}`); }
    return b;
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(this.cdp, sessionId, targetId);
    await p.init();
    return p;
  }

  async close(): Promise<void> {
    try { await this.cdp.send('Browser.close', {}, undefined, 3000); } catch { /* it may already be gone */ }
    await sleep(150);
    killTree(this.proc);
    await sleep(300);
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(this.dir, { recursive: true, force: true }); return; } catch { await sleep(300); }
    }
  }
}
