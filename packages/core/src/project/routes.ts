/*
 * Pages and endpoints read from the project's own files at a commit: the router folders of the common frameworks,
 * plain HTML files, Express-style and NestJS routes in code, and the repository's own OpenAPI file. It reads; it runs nothing.
 */
import { isGenerated, isTestPath } from '../lang.js';
import { InputError, normalizeParams, readOpenApiText, type EndpointEntry, type PageEntry } from './inputs.js';

export interface RoutesRead { pages: PageEntry[]; endpoints: EndpointEntry[]; frameworks: string[]; notes: string[] }

const PAGE_EXT = /\.(?:tsx|jsx|ts|js|mdx|md|vue|astro|svelte)$/;
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SPEC_FILE = /(?:^|\/)(?:openapi|swagger)(?:[.-][\w-]+)?\.(?:json|ya?ml)$/i;

const skipped = (p: string): boolean => isGenerated(p) || isTestPath(p) || /(?:^|\/)\.[^/]+\//.test(p) || p.endsWith('.d.ts');

/** A route made of folder segments: groups `(x)` dropped, `index` dropped, parameters as {name}. Null when a segment makes it no route (`_private`, `@slot`). */
function routeOf(segments: string[]): { path: string; dynamic: boolean } | null {
  const kept: string[] = [];
  for (const s of segments) {
    if (!s || /^\(.*\)$/.test(s) || s === 'index') continue;
    if (s.startsWith('_') || s.startsWith('@')) return null;
    kept.push(s);
  }
  const path = normalizeParams(`/${kept.join('/')}`);
  return { path, dynamic: path.includes('{') };
}

/** The HTTP methods a route file exports (`export async function GET`, `export const POST =`), or * when it exports none Assay can see. */
function exportedVerbs(text: string | null | undefined): string[] {
  if (!text) return ['*'];
  const found = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+|let\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) found.add(m[1]);
  return found.size ? VERBS.filter(v => found.has(v)) : ['*'];
}

/** Which frameworks the project uses, from config file names and package.json dependencies. */
function frameworksOf(files: string[], text: (p: string) => string | null | undefined): Set<string> {
  const fw = new Set<string>();
  const base = (p: string): string => p.split('/').pop() ?? p;
  for (const p of files) {
    if (skipped(p)) continue;
    const b = base(p);
    if (/^next\.config\.\w+$/.test(b)) fw.add('next');
    else if (/^nuxt\.config\.\w+$/.test(b)) fw.add('nuxt');
    else if (/^astro\.config\.\w+$/.test(b)) fw.add('astro');
    else if (/^svelte\.config\.\w+$/.test(b)) fw.add('sveltekit');
    else if (/^(?:remix|react-router)\.config\.\w+$/.test(b)) fw.add('remix');
    else if (b === 'package.json') {
      const t = text(p);
      if (!t) continue;
      if (/"next"\s*:/.test(t)) fw.add('next');
      if (/"nuxt"\s*:/.test(t)) fw.add('nuxt');
      if (/"astro"\s*:/.test(t)) fw.add('astro');
      if (/"@sveltejs\/kit"\s*:/.test(t)) fw.add('sveltekit');
      if (/"@remix-run\/[\w-]+"\s*:|"@react-router\/dev"\s*:/.test(t)) fw.add('remix');
      if (/"@nestjs\/core"\s*:/.test(t)) fw.add('nest');
      if (/"express"\s*:|"fastify"\s*:|"hono"\s*:|"koa-router"\s*:|"@koa\/router"\s*:/.test(t)) fw.add('express');
    }
  }
  return fw;
}

/** Remix and React Router flat routes: `app/routes/cart.$id.tsx` is /cart/{id}, `_index` is the parent, a leading `_` segment is a layout. */
function flatRoute(name: string): { path: string; dynamic: boolean } | null {
  const segs = name.replace(/\[\.\]/g, '\u0000').split('.').map(s => s.replace(/\u0000/g, '.'));
  const kept: string[] = [];
  for (const s of segs) {
    if (s === '_index' || s === 'route' || s.startsWith('_')) continue;
    kept.push(s.replace(/_$/, '').replace(/^\$$/, '{splat}'));
  }
  const path = normalizeParams(`/${kept.join('/')}`);
  return { path, dynamic: path.includes('{') };
}

/**
 * Routes from Express-style calls (`app.get('/x', …)`, `router.post(…)`) and NestJS decorators (`@Controller('users')` with `@Get(':id')`).
 * Written as the file says them: a prefix the router is mounted under elsewhere isn't known.
 */
function codeRoutes(file: string, text: string): EndpointEntry[] {
  const out: EndpointEntry[] = [];
  for (const m of text.matchAll(/\b(?:app|router|server|api|routes?)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])(\/[^'"`$]*)\2/g)) {
    out.push({ method: m[1] === 'all' ? '*' : m[1].toUpperCase(), path: normalizeParams(m[3]) || '/', from: ['code'], file });
  }
  if (/@Controller\s*\(/.test(text)) {
    const ctrl = /@Controller\s*\(\s*(?:(['"`])([^'"`]*)\1|\{[^}]*path\s*:\s*(['"`])([^'"`]*)\3)?/.exec(text);
    const prefix = (ctrl?.[2] ?? ctrl?.[4] ?? '').replace(/^\/+|\/+$/g, '');
    for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g)) {
      const sub = (m[3] ?? '').replace(/^\/+|\/+$/g, '');
      const p = `/${[prefix, sub].filter(Boolean).join('/')}`;
      out.push({ method: m[1] === 'All' ? '*' : m[1].toUpperCase(), path: normalizeParams(p), from: ['code'], file });
    }
  }
  return out;
}

/**
 * Every page and endpoint the project's files describe. `files` are the paths tracked at the commit, `text` reads one
 * (null when it is binary or too big). Nothing here loads a page or calls the app.
 */
export function routesFromFiles(files: string[], text: (p: string) => string | null | undefined): RoutesRead {
  const fw = frameworksOf(files, text);
  const pages: PageEntry[] = [];
  const endpoints: EndpointEntry[] = [];
  const notes: string[] = [];
  const page = (r: { path: string; dynamic: boolean } | null, from: PageEntry['from'][number], file: string): void => {
    if (r) pages.push({ path: r.path, from: [from], file, ...(r.dynamic ? { dynamic: true } : {}) });
  };
  for (const file of files) {
    if (skipped(file)) continue;
    let m: RegExpExecArray | null;
    // Next.js app router: app/**/page.tsx is a page, app/**/route.ts an endpoint.
    if (fw.has('next') && (m = /(?:^|\/)app\/((?:[^/]+\/)*)(page|route)\.(?:tsx|jsx|ts|js|mdx)$/.exec(file))) {
      const r = routeOf(m[1].split('/'));
      if (m[2] === 'page') page(r, 'router', file);
      else if (r) for (const v of exportedVerbs(text(file))) endpoints.push({ method: v, path: r.path, from: ['router'], file });
      continue;
    }
    // Next.js pages router, Nuxt, Astro: pages/**.
    if ((fw.has('next') || fw.has('nuxt') || fw.has('astro')) && (m = /(?:^|\/)pages\/(.+)$/.exec(file)) && PAGE_EXT.test(file)) {
      const rel = m[1].replace(PAGE_EXT, '');
      const segs = rel.split('/');
      if (segs[segs.length - 1].startsWith('_')) continue;
      const r = routeOf(segs);
      const isEndpoint = (fw.has('next') && segs[0] === 'api') || (fw.has('astro') && /\.(?:ts|js)$/.test(file) && !fw.has('next'));
      if (isEndpoint) { if (r) for (const v of exportedVerbs(text(file))) endpoints.push({ method: v === '*' && fw.has('next') ? '*' : v, path: r.path, from: ['router'], file }); }
      else page(r, 'router', file);
      continue;
    }
    // SvelteKit: src/routes/**/+page.svelte and +server.ts.
    if (fw.has('sveltekit') && (m = /(?:^|\/)src\/routes\/((?:[^/]+\/)*)\+(page|server)\.(?:svelte|ts|js)$/.exec(file))) {
      const r = routeOf(m[1].split('/'));
      if (m[2] === 'page') page(r, 'router', file);
      else if (r) for (const v of exportedVerbs(text(file))) endpoints.push({ method: v, path: r.path, from: ['router'], file });
      continue;
    }
    // Remix and React Router: app/routes/<flat name>.tsx, or app/routes/<flat name>/route.tsx.
    if (fw.has('remix') && (m = /(?:^|\/)app\/routes\/([^/]+?)(?:\/route)?\.(?:tsx|jsx|ts|js|mdx)$/.exec(file))) {
      page(flatRoute(m[1]), 'router', file);
      continue;
    }
    if (/\.html?$/i.test(file) && !/(?:^|\/)(?:docs?|templates?|partials?|includes?|layouts?)\//i.test(file)) {
      const at = file.replace(/^(?:public|static)\//, '').replace(/(?:^|\/)index\.html?$/i, '');
      page({ path: `/${at.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/', dynamic: false }, 'html', file);
      continue;
    }
    if ((fw.has('express') || fw.has('nest')) && /\.(?:ts|js|mjs|cjs)$/.test(file)) {
      const t = text(file);
      if (t && t.length < 512 * 1024) endpoints.push(...codeRoutes(file, t));
    }
  }
  for (const file of files) {
    if (skipped(file) || !SPEC_FILE.test(file)) continue;
    const t = text(file);
    if (!t) continue;
    try { endpoints.push(...readOpenApiText(t, file)); }
    catch (e) { if (e instanceof InputError) notes.push(`${file} looks like an OpenAPI file but couldn’t be read: ${e.message}`); else throw e; }
  }
  return { pages, endpoints, frameworks: [...fw].sort(), notes };
}
