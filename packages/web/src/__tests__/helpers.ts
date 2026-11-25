import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Dashboard } from '../index.js';

/** Dashboard tests build their own repositories and their own state folder. They never touch a real repository or a real ~/.assay. */
export const SECRET = 'AKIAQWERTYUIOP123456';

const env = { ...process.env, GIT_AUTHOR_NAME: 'octocat', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_NAME: 'octocat', GIT_COMMITTER_EMAIL: 'o@example.com' };

export function makeRepo(commits: Array<{ files: Record<string, string>; message: string }>, name = 'shop-website'): { dir: string; hashes: string[] } {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-repo-')), name);
  fs.mkdirSync(dir);
  const git = (...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  const hashes: string[] = [];
  for (const c of commits) {
    for (const [f, text] of Object.entries(c.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', c.message);
    hashes.push(git('rev-parse', 'HEAD').trim());
  }
  return { dir, hashes };
}

export interface Res { status: number; headers: http.IncomingHttpHeaders; text: string; body: Buffer; json: any }

export function request(port: number, method: string, p: string, o: { cookie?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string> = { ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
    if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** A signed-in page: what the browser does after the first load. */
export async function signIn(d: Dashboard): Promise<{ cookie: string; get: (p: string) => Promise<Res>; post: (p: string, body?: unknown) => Promise<Res>; job: (p: string, body: unknown, ms?: number) => Promise<any> }> {
  const login = await request(d.port, 'GET', `/?token=${d.token}`);
  const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0];
  const get = (p: string): Promise<Res> => request(d.port, 'GET', p, { cookie });
  const post = (p: string, body: unknown = {}): Promise<Res> => request(d.port, 'POST', p, { cookie, body, headers: { origin: d.origin, 'content-type': 'application/json' } });
  const job = async (p: string, body: unknown, ms = 120_000): Promise<any> => {
    const start = await post(p, body);
    if (start.status !== 200) throw new Error(`${p}: ${start.status} ${start.text}`);
    let j = start.json;
    const until = Date.now() + ms;
    while ((j.state === 'queued' || j.state === 'running') && Date.now() < until) {
      await sleep(150);
      j = (await get(`/api/job?id=${j.id}`)).json;
    }
    return j;
  };
  return { cookie, get, post, job };
}
