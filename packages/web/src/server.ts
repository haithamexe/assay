import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetsDir, memory, repoName, repoRoot } from '@assay/core';
import { Binary, handleApi, HttpError, type Ctx } from './api.js';
import { Jobs } from './jobs.js';
import { COOKIE, CSP, cookieOf, hostOk, newToken, originOk, safeEqual } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');
const MAX_BODY = 64 * 1024;
const FONTS = new Set(['geist.woff2', 'geist-mono.woff2', 'silkscreen.woff2']);

export interface DashboardOptions {
  /** The repository to show. */
  repo: string;
  /** A fixed port; without one the system picks a free one. */
  port?: number;
}

export interface Dashboard {
  /** The address that signs the first page load in. It is only good for the run that printed it. */
  url: string;
  origin: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const read = (file: string): Buffer | null => { try { return fs.readFileSync(file); } catch { return null; } };

function version(): string {
  try { return (JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

/** The mark from the demo, as a tab icon. Drawn from the same grid of squares. */
function favicon(): string {
  const grid = '...xxxxx....|..x.....x...|.x.sss...x..|.xsssss..x..|.x.sss...x..|.x.......x..|..x.....xx..|...xxxxx.xx.|.........xxx|..........xx'.split('|');
  let rects = '';
  grid.forEach((row, y) => [...row].forEach((c, x) => { if (c !== '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c === 's' ? '#e2e941' : '#733bde'}"/>`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" shape-rendering="crispEdges">${rects}</svg>`;
}

/** What a path is served from. Only these names: nothing in the URL is ever joined to a path without being matched first. */
function asset(pathname: string): { body: Buffer; type: string } | null {
  if (pathname === '/' || pathname === '/index.html') { const b = read(path.join(publicDir, 'index.html')); return b && { body: b, type: 'text/html; charset=utf-8' }; }
  if (pathname === '/favicon.svg') return { body: Buffer.from(favicon()), type: 'image/svg+xml' };
  if (pathname === '/css/dashboard.css') { const b = read(path.join(publicDir, 'dashboard.css')); return b && { body: b, type: 'text/css; charset=utf-8' }; }
  if (pathname === '/css/base.css') {
    // The shared stylesheet, with its fonts pointed at this server instead of embedded, because the page may only load from here.
    const b = read(path.join(assetsDir, 'report.css'));
    if (!b) return null;
    const css = b.toString('utf8')
      .replace('url(data:font/woff2;base64,__GEIST_MONO__)', 'url(/fonts/geist-mono.woff2)')
      .replace('url(data:font/woff2;base64,__GEIST__)', 'url(/fonts/geist.woff2)')
      .replace('url(data:font/woff2;base64,__SILKSCREEN__)', 'url(/fonts/silkscreen.woff2)');
    return { body: Buffer.from(css), type: 'text/css; charset=utf-8' };
  }
  const font = /^\/fonts\/([a-z-]+\.woff2)$/.exec(pathname);
  if (font && FONTS.has(font[1])) { const b = read(path.join(assetsDir, 'fonts', font[1])); return b && { body: b, type: 'font/woff2' }; }
  const js = /^\/js\/([a-z0-9-]+\.js)$/.exec(pathname);
  if (js) { const b = read(path.join(publicDir, 'js', js[1])); return b && { body: b, type: 'text/javascript; charset=utf-8' }; }
  return null;
}

function headers(res: http.ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(body);
}
const sendJson = (res: http.ServerResponse, status: number, value: unknown): void => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
const sendText = (res: http.ServerResponse, status: number, message: string): void => send(res, status, 'text/plain; charset=utf-8', message);

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'That request is too big.')); chunks.length = 0; return; }
      chunks.push(b);
    });
    req.on('end', () => {
      if (!size) { resolve({}); return; }
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) resolve(v as Record<string, unknown>); else reject(new HttpError(400, 'The request must be a JSON object.'));
      } catch { reject(new HttpError(400, 'The request is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

const SIGNED_OUT = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>assay</title><h1>assay</h1><p>This page needs the address that <code>assay dashboard</code> printed in your terminal. It has a key in it that only that run knows.</p>';

/** Starts the dashboard for one repository. It answers on 127.0.0.1 only. */
export async function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const repo = repoRoot(opts.repo);
  const token = newToken();
  const jobs = new Jobs();
  const ctx: Ctx = { repo, name: repoName(repo), version: version(), jobs };
  let port = 0;

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) { res.destroy(); return; }
      // A refused body may still be arriving: answer, then close the connection instead of reading the rest.
      if (err instanceof HttpError) { if (err.status === 413) res.setHeader('Connection', 'close'); sendJson(res, err.status, { error: err.message, ...err.extra }); }
      else sendJson(res, 500, { error: err instanceof Error ? err.message : 'Something went wrong.' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    headers(res);
    if (!hostOk(req, port)) { sendText(res, 403, 'This server only answers on 127.0.0.1.'); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!safeEqual(url.searchParams.get('token') ?? '', token)) { send(res, 401, 'text/html; charset=utf-8', `${SIGNED_OUT}<p>That address is not the one this run made.</p>`); return; }
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
      res.end();
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    const key = cookieOf(req);
    if (!key || !safeEqual(key, token)) {
      if (url.pathname.startsWith('/api/')) sendJson(res, 401, { error: 'Not signed in. Open the address that assay dashboard printed.' });
      else send(res, 401, 'text/html; charset=utf-8', SIGNED_OUT);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      let body: Record<string, unknown> = {};
      if (method === 'POST') {
        if (!originOk(req, port)) throw new HttpError(403, 'That request did not come from this page.');
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
        body = await readBody(req);
      } else if (method !== 'GET') {
        throw new HttpError(405, 'GET or POST only.');
      }
      const out = await handleApi(ctx, method, url.pathname, { query: url.searchParams, body });
      if (out instanceof Binary) send(res, 200, out.type, out.data, { 'Cache-Control': 'private, no-cache' });
      else sendJson(res, 200, out);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') { sendText(res, 405, 'GET only.'); return; }
    const a = asset(url.pathname);
    if (!a) { sendText(res, 404, 'Not found.'); return; }
    send(res, 200, a.type, method === 'HEAD' ? '' : a.body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE' ? new Error(`Port ${opts.port} is already in use. Pick another with --port, or leave it out for a free one.`) : err));
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/?token=${token}`, origin, port, token,
    async close(): Promise<void> {
      await jobs.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      memory.closeMemory();
    }
  };
}
