// Regenerates the two sample reports in demo/ from fixture repositories (a sample project called "shop-website").
//   npm run samples        (builds first; the second sample needs a Chromium-based browser on the machine)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dist = new URL('packages/core/dist/', root);
const fx = await import(new URL('__tests__/fixtures.js', dist));
fx.tempHome();
const core = await import(new URL('index.js', dist));
import { CSS, HEAD_CSS, HEAD_INDEX, INDEX } from './shop.mjs';
const out = name => fileURLToPath(new URL(`demo/${name}`, root));

/* 1. the free checks on a repository with planted mistakes: a committed key, a risky pattern, a guard removed, a look-alike package */
{
  const { repo, hashes } = fx.plantedRepo('shop-website');
  const c = core.openCase({ repo: repo.dir, range: `${hashes[0]}..${hashes[5]}` });
  fs.writeFileSync(out('sample-report.html'), core.reportHTML(c));
  console.log('demo/sample-report.html  ', core.verdictOf(c).headline);
}

/* 2. the browser checks on an order-summary card whose redesign breaks the mirrored layout */
if (!core.findBrowser()) {
  console.log('demo/sample-look-report.html  skipped: no Chromium-based browser found (set ASSAY_BROWSER)');
} else {
  const repo = fx.makeRepo('shop-website');
  const base = repo.commit({ 'index.html': INDEX, 'style.css': CSS }, 'Checkout: order summary');
  const head = repo.commit({ 'index.html': HEAD_INDEX, 'style.css': HEAD_CSS }, 'Checkout: redesign the order summary card');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  await core.lookCase(c, { onProgress: m => console.log('  ..', m) });
  fs.writeFileSync(out('sample-look-report.html'), core.reportHTML(c));
  console.log('demo/sample-look-report.html  ', core.verdictOf(c).headline);
}
