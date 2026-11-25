// This is a public, open-source repository: nothing personal belongs in it. This looks for what shouldn't be there before it is committed.
//   npm run check:public                      files that are tracked, or new and not ignored
//   npm run check:public -- --history         also the author and committer addresses in the git history
//   ASSAY_DENY="a name,another name" npm run check:public     words you never want to see (kept out of the repository on purpose)
// Looks for: email addresses (except example.com, a reserved ".invalid" address and GitHub no-reply addresses), home-folder paths, and the words in ASSAY_DENY.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(?:example\.(?:com|org)|users\.noreply\.github\.com|anthropic\.com)$|@[^@\s]+\.invalid$|^git@/i;
const HOME_PATH = [/[A-Za-z]:[\\/]+Users[\\/]+(?!user\b|name\b|you\b|me\b|Public\b|Default\b|<)[^\\/\s'"`]+/g, /\/Users\/(?!user\b|name\b|you\b|me\b|<)[a-z][\w.-]*\//g, /\/home\/(?!user\b|name\b|you\b|me\b|runner\b|<)[a-z][\w.-]*\//g];
const deny = (process.env.ASSAY_DENY ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
const SKIP = /(^|\/)(package-lock\.json)$|\.(png|jpe?g|gif|woff2?|ttf|ico|svg)$/i;

const found = [];
const files = git(['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
for (const f of files) {
  if (SKIP.test(f)) continue;
  let text;
  try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  // Embedded data (fonts and pictures as base64) is long runs of letters that can look like anything: leave those lines out.
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/[A-Za-z0-9+/=]{200,}/.test(line)) return;
    const hit = (what, s) => found.push(`${f}:${i + 1}  ${what}: ${s}`);
    for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) hit('email', m[0]);
    for (const re of HOME_PATH) for (const m of line.matchAll(re)) hit('home path', m[0]);
    for (const re of deny) { const m = re.exec(line); if (m) hit('denied word', m[0]); }
  });
}

if (process.argv.includes('--history')) {
  const who = new Set(git(['log', '--format=%ae%n%ce']).split('\n').filter(Boolean));
  for (const e of who) if (!ALLOWED_EMAIL.test(e)) found.push(`git history  author or committer address: ${e}  (rewriting history is a decision for the maintainer; later commits can use a GitHub no-reply address)`);
}

if (found.length) {
  console.error(`${found.length} thing${found.length === 1 ? '' : 's'} that shouldn't be in a public repository:\n`);
  for (const f of found) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`Nothing personal found in ${files.length} files${process.argv.includes('--history') ? ' and the git history' : ''}.`);
