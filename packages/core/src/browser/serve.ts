import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { killTree } from '../proof/runner.js';

/** Where a page can be loaded from. Always this computer: a loopback address, never anything else. */
export interface Served {
  origin: string;
  stop(): Promise<void>;
  /** What the server printed, for saying why it didn't start. */
  log(): string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json'
};

/** The checkout's files, as they are, and nothing outside the checkout. The files are the project's: scripts in them run in the browser's sandbox, not here. */
export function staticServer(root: string): Promise<Served> {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(base, `.${path.sep}${rel.replace(/^\/+/, '')}`);
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
      let target = file;
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      if (!fs.existsSync(target)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(target).pipe(res);
    } catch { res.writeHead(400).end(); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ origin: `http://127.0.0.1:${port}`, log: () => '', stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const LOOPBACK = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)/;

async function answers(origin: string): Promise<boolean> {
  try { const r = await fetch(origin, { signal: AbortSignal.timeout(2000), redirect: 'manual' }); void r.body?.cancel(); return true; } catch { return false; }
}

/**
 * The project's own dev server, started with the command the project (or the person) gave, with PORT set. Ready when it answers on a loopback address,
 * the one it printed or the port we offered. `{port}` in the command is replaced by the port.
 */
export async function devServer(command: string, cwd: string, timeoutSec: number): Promise<Served | { error: string }> {
  const port = await freePort();
  const text = command.replace(/\{port\}/g, String(port));
  const detached = process.platform !== 'win32';
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ASSAY_RUN: '1' };
  delete env.NODE_TEST_CONTEXT;
  let child: ChildProcess;
  try { child = spawn(text, { cwd, shell: true, env, windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return { error: (e as Error).message }; }
  let out = '';
  let exited: number | null | undefined;
  const grab = (b: Buffer): void => { out = (out + b.toString('utf8')).slice(-6000); };
  child.stdout?.on('data', grab);
  child.stderr?.on('data', grab);
  child.on('exit', code => { exited = code; });
  child.on('error', e => { out += `\n${e.message}`; exited = -1; });
  const stop = async (): Promise<void> => { killTree(child); await sleep(300); };
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (exited !== undefined) { return { error: `The dev server stopped (exit ${exited}) before it was ready.\n${out.split('\n').slice(-8).join('\n')}` }; }
    const printed = LOOPBACK.exec(out);
    for (const origin of [printed ? `http://127.0.0.1:${printed[1]}` : '', printed ? `http://localhost:${printed[1]}` : '', `http://127.0.0.1:${port}`, `http://localhost:${port}`].filter(Boolean)) {
      if (await answers(origin)) return { origin, stop, log: () => out };
    }
    await sleep(500);
  }
  await stop();
  return { error: `The dev server did not answer within ${timeoutSec} s.\n${out.split('\n').slice(-8).join('\n')}` };
}
