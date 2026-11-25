import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway ASSAY_HOME. Call before importing anything that reads it. */
export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-home-'));
  process.env.ASSAY_HOME = dir;
  return dir;
}

export interface Repo { dir: string; git(...args: string[]): string; commit(files: Record<string, string | null>, message: string): string }

export function makeRepo(name = 'assay-repo'): Repo {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-repo-'));
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  let n = 0;
  const run = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'octocat', GIT_AUTHOR_EMAIL: 'octocat@example.com', GIT_COMMITTER_NAME: 'octocat', GIT_COMMITTER_EMAIL: 'octocat@example.com' }
  });
  run('init', '-q', '-b', 'main');
  run('config', 'commit.gpgsign', 'false');
  return {
    dir, git: run,
    commit(files, message) {
      for (const [f, content] of Object.entries(files)) {
        const p = path.join(dir, f);
        if (content === null) fs.rmSync(p, { force: true });
        else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
      }
      run('add', '-A');
      n++;
      const date = `2025-11-${String(n).padStart(2, '0')}T10:00:00Z`;
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], {
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 'octocat', GIT_AUTHOR_EMAIL: 'octocat@example.com', GIT_COMMITTER_NAME: 'octocat', GIT_COMMITTER_EMAIL: 'octocat@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      });
      return run('rev-parse', 'HEAD').trim();
    }
  };
}

export const SECRET = 'AKIAQWERTYUIOP123456';

const CART_OLD = `class BadRequest(Exception):
    pass


def apply_coupon(cart, code):
    if not cart.items:
        raise BadRequest("cart is empty")
    rule = COUPONS.get(code)
    if rule is None:
        raise BadRequest("coupon is not valid")
    return rule
`;
const CART_NEW = CART_OLD.replace('    if not cart.items:\n        raise BadRequest("cart is empty")\n', '    first = cart.items[0]\n');

const TSX_OLD = `export function CouponError({ error }: { error?: string }) {
  if (!error) return null;
  return <p className="coupon-error">{error}</p>;
}
`;
const TSX_NEW = `export function CouponError({ error }: { error?: string }) {
  if (!error) return null;
  const text = String(error).trim();
  const long = text.length > 80;
  const label = long ? text.slice(0, 80) : text;
  const html = label.replace(/\\n/g, '<br>');
  const cls = long ? 'coupon-error long' : 'coupon-error';
  const kind = long ? 'long' : 'short';
  const title = long ? text : undefined;
  const role = 'alert';
  const size = html.length;
  const key = 'coupon-' + size;
  return <p key={key} role={role} title={title} className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}
`;

const TOTALS = `def total(items):
    amount = 0
    for item in items:
        amount += item.price * item.qty
    return amount


def count(items):
    n = 0
    for item in items:
        n += item.qty
    return n


def first_price(items):
    return items[0].price
`;

const PKG_OLD = `{
  "name": "shop",
  "dependencies": {
    "react": "^19.0.0",
    "zod": "^3.24.0"
  },
  "scripts": { "test": "node --test" }
}
`;
const PKG_NEW = `{
  "name": "shop",
  "dependencies": {
    "react": "^19.0.0",
    "reactt": "^1.0.0",
    "zod": "^3.24.0"
  },
  "scripts": { "test": "node --test", "postinstall": "node setup.js" }
}
`;

/**
 * Six commits with known mistakes planted in them:
 *  1 base          clean
 *  2 coupon error  dangerouslySetInnerHTML, no test changed
 *  3 totals        a guard removed in cart.py, a new totals.py, no test changed
 *  4 settings      a committed AWS-style key
 *  5 deps          a look-alike package and an install script
 *  6 cleanup       the key is removed again
 */
export function plantedRepo(name = 'assay-repo', before?: (repo: Repo) => void): { repo: Repo; hashes: string[] } {
  const repo = makeRepo(name);
  before?.(repo);
  const h: string[] = [];
  h.push(repo.commit({ 'src/cart.py': CART_OLD, 'web/CouponError.tsx': TSX_OLD, 'tests/test_cart.py': 'def test_a():\n    assert True\n', 'package.json': PKG_OLD, 'README.md': '# shop\n' }, 'Base'));
  h.push(repo.commit({ 'web/CouponError.tsx': TSX_NEW }, 'Show coupon errors in the cart'));
  h.push(repo.commit({ 'src/cart.py': CART_NEW, 'src/totals.py': TOTALS }, 'Apply coupons on the server'));
  h.push(repo.commit({ 'config/settings.py': `AWS_KEY = "${SECRET}"\nREGION = "eu-west-1"\n` }, 'Add settings'));
  h.push(repo.commit({ 'package.json': PKG_NEW }, 'Add reactt'));
  h.push(repo.commit({ 'config/settings.py': 'AWS_KEY = None\nREGION = "eu-west-1"\n' }, 'Remove the key'));
  return { repo, hashes: h };
}
