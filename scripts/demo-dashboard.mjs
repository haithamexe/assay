// A sample project to try the dashboard on: "shop-website", a throwaway repository with planted mistakes (a committed key,
// risky code, a guard removed, a look-alike package) and a checkout redesign that breaks the mirrored layout.
// It lives in a temporary folder with its own Assay state, and running its tests and pages is switched on for it, so every button works.
//   npm run dashboard:demo [-- --port 4747]      (builds first; "Look at the pages" needs a Chromium-based browser on the machine)
import { shopProject } from './shop.mjs';

const root = new URL('../', import.meta.url);
const dist = pkg => new URL(`packages/${pkg}/dist/`, root);
const fx = await import(new URL('__tests__/fixtures.js', dist('core')));
fx.tempHome();
const core = await import(new URL('index.js', dist('core')));
const { startDashboard } = await import(new URL('index.js', dist('web')));

const { repo } = shopProject(fx, core);

const at = process.argv.indexOf('--port');
const d = await startDashboard({ repo: repo.dir, port: at > 0 ? Number(process.argv[at + 1]) : undefined });
console.log(`assay dashboard (sample project)\n\n  ${d.url}\n\nOpen that address in your browser. Press Ctrl+C to stop.`);
const stop = () => { d.close().then(() => process.exit(0)); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
