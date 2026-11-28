/*
 * Plain inputs another tool (or a person) can hand to project mode, so Assay never needs that tool (D59, D60):
 * an address of an app running on this computer, a list of pages, a HAR file, a file of steps, an OpenAPI file.
 * Each reader is strict: known shapes only, sizes capped, and nothing but paths, methods and counts is kept from a HAR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '@haithamexe/plainkit/yaml';

export class InputError extends Error {}

/** Where a page or an endpoint was found. */
export type Source = 'pages' | 'settings' | 'router' | 'html' | 'code' | 'openapi' | 'har' | 'flow';

export interface PageEntry {
  /** A path on the app, starting with one slash. A dynamic page shows its parameters as {name}. */
  path: string;
  from: Source[];
  /** The file that defines it, when a file does. */
  file?: string;
  /** It has a parameter, so it can't be loaded until something gives a value. */
  dynamic?: boolean;
}

/** One property of a JSON request body, as an OpenAPI file describes it: its name and type, never an example or a default (D64). */
export interface BodyField { name: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'other'; required: boolean }

export interface EndpointEntry {
  /** GET, POST… or * when the file doesn't say. */
  method: string;
  /** Parameters as {name}, whatever the source wrote (`:id`, `[id]`, `{id}`). */
  path: string;
  from: Source[];
  file?: string;
  /** The top-level properties of its JSON request body, from an OpenAPI file. Kept out of a checkup's list unless asked for (the attack check builds a body from it). */
  body?: BodyField[];
}

/** One thing to do on a page, like a person would. Exactly one action per step. Elements are a CSS selector or "text=Sign in". */
export interface FlowStep {
  goto?: string;
  click?: string;
  /** With click: twice, quickly. */
  double?: boolean;
  back?: boolean;
  type?: string;
  /** With type: the field to type into (otherwise the focused one). */
  into?: string;
  press?: string;
  /** An element, "text=…", or "url=…" to wait for. */
  waitFor?: string;
  timeoutMs?: number;
}

export interface Flow { name: string; start: string; steps: FlowStep[]; /** Steps of a recording that have no equivalent (a scroll, a hover) and were left out. */ skipped: number }

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost)$/i;
const ACTIONS = ['goto', 'click', 'back', 'type', 'press', 'waitFor'] as const;
const STEP_FIELDS = new Set<string>([...ACTIONS, 'double', 'into', 'timeoutMs']);
export const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
const MAX_STEPS = 500;
const MAX_TEXT = 2000;
const MAX_SELECTOR = 500;

/** An app running on this computer: http(s), a loopback host, no user name or password. Returned without query or fragment. */
export function checkUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new InputError(`"${input.slice(0, 80)}" is not an address. Give one like http://localhost:3000`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InputError('The address must start with http:// or https://');
  if (u.username || u.password) throw new InputError('The address must not carry a user name or a password.');
  if (!LOOPBACK_HOST.test(u.hostname)) throw new InputError('Assay checks only an app running on this computer: localhost, 127.0.0.1, [::1] or a name ending in .localhost.');
  const base = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${base}`;
}

/** A path on the app: one leading slash, no backslash, no spaces or control characters, no host. The fragment is dropped. */
export function checkPagePath(input: string): string {
  const p = input.trim().replace(/#.*$/, '');
  // eslint-disable-next-line no-control-regex
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\s\x00-\x1f\x7f]/.test(p) || p.length > 2000) {
    throw new InputError(`"${input.slice(0, 80)}" is not a page path. Give paths like /cart, starting with one slash.`);
  }
  return p;
}

function readInputFile(file: string, max: number, what: string): string {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { throw new InputError(`No ${what} at ${file}.`); }
  if (!st.isFile()) throw new InputError(`${file} is not a file.`);
  if (st.size > max) throw new InputError(`The ${what} is ${Math.round(st.size / 1024 / 1024)} MB; Assay reads at most ${Math.round(max / 1024 / 1024)} MB.`);
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new InputError(`The ${what} is not valid JSON.`); }
}

/** Parameters written as `:id`, `[id]`, `[...slug]` or `$id` become {id}. */
export function normalizeParams(p: string): string {
  return p
    .replace(/\[\[?\.\.\.([^\]]+)\]?\]/g, '{$1}')
    .replace(/\[([^\]]+)\]/g, '{$1}')
    .replace(/(^|\/):([A-Za-z_][\w]*)\??/g, '$1{$2}')
    .replace(/(^|\/)\$([A-Za-z_][\w]*)/g, '$1{$2}');
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[0-9A-Za-z_-]{20,})$/i;
/** A recorded call's path with its ids folded into {id}, so /items/1 and /items/2 are one endpoint. */
const foldIds = (p: string): string => p.split('/').map(s => (s && ID_SEGMENT.test(s) && /\d/.test(s) ? '{id}' : s)).join('/');

const sameHost = (a: string, b: string): boolean => {
  const loop = (h: string): string => (LOOPBACK_HOST.test(h) && !h.endsWith('.localhost') ? 'loopback' : h.toLowerCase());
  return loop(a) === loop(b);
};

export interface HarRead { pages: PageEntry[]; endpoints: EndpointEntry[]; notes: string[]; requests: number }

/**
 * Pages and calls from a HAR file (a browser's recording of its network traffic, what DevTools' "Save all as HAR" writes).
 * Only the recording's own site is kept: the origin of its first page, or the app's address when one is given. Only the
 * method, the path (ids folded) and the kind are kept: never a header, a cookie, a query value or a body.
 */
export function readHar(file: string, opts: { url?: string | null } = {}): HarRead {
  const doc = parseJson(readInputFile(file, 64 * 1024 * 1024, 'HAR file'), 'HAR file') as { log?: { entries?: unknown } };
  const entries = doc?.log?.entries;
  if (!Array.isArray(entries)) throw new InputError('This is not a HAR file: it has no log.entries list.');
  type Entry = { request?: { method?: unknown; url?: unknown }; response?: { status?: unknown; content?: { mimeType?: unknown } }; _resourceType?: unknown };
  const parsed: Array<{ method: string; url: URL; status: number; mime: string; kind: string }> = [];
  for (const e of entries as Entry[]) {
    const method = typeof e?.request?.method === 'string' ? e.request.method.toUpperCase() : '';
    if (!METHODS.includes(method) || typeof e.request?.url !== 'string') continue;
    let url: URL;
    try { url = new URL(e.request.url); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const status = typeof e.response?.status === 'number' ? e.response.status : 0;
    const mime = typeof e.response?.content?.mimeType === 'string' ? e.response.content.mimeType.toLowerCase() : '';
    parsed.push({ method, url, status, mime, kind: typeof e._resourceType === 'string' ? e._resourceType.toLowerCase() : '' });
  }
  const isDoc = (r: (typeof parsed)[number]): boolean => r.method === 'GET' && (r.kind === 'document' || (!r.kind && r.mime.includes('text/html')));
  let host: string | null = null, port = '';
  if (opts.url) { const u = new URL(opts.url); host = u.hostname; port = u.port; }
  const first = parsed.find(isDoc) ?? parsed[0];
  const own = (u: URL): boolean => {
    if (first && u.hostname === first.url.hostname && u.port === first.url.port) return true;
    return host !== null && sameHost(u.hostname, host) && u.port === port;
  };
  const pages = new Map<string, PageEntry>();
  const endpoints = new Map<string, EndpointEntry>();
  let other = 0;
  for (const r of parsed) {
    if (!own(r.url)) { other++; continue; }
    const p = r.url.pathname || '/';
    if (isDoc(r)) {
      if (r.status < 400) pages.set(p, { path: p, from: ['har'] });
      continue;
    }
    const call = r.kind === 'xhr' || r.kind === 'fetch' || /json|xml|text\/plain|form/.test(r.mime) || r.method !== 'GET';
    if (!call || /^(?:script|stylesheet|image|font|media|manifest|websocket)$/.test(r.kind)) continue;
    const ep = foldIds(p);
    endpoints.set(`${r.method} ${ep}`, { method: r.method, path: ep, from: ['har'] });
  }
  const notes: string[] = [];
  if (other) notes.push(`${other} request${other === 1 ? '' : 's'} in the HAR went to other sites and ${other === 1 ? 'was' : 'were'} left out.`);
  if (host !== null && first && !(sameHost(first.url.hostname, host) && first.url.port === port)) notes.push('The HAR was recorded on another address than the app’s: its paths are used on the app’s address.');
  return { pages: [...pages.values()], endpoints: [...endpoints.values()], notes, requests: parsed.length };
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** One step, checked: exactly one action, known fields only, a path for goto, a key from the list for press. */
function checkStep(raw: unknown, where: string): FlowStep {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`${where} is not a step.`);
  const s = raw as Record<string, unknown>;
  const unknown = Object.keys(s).filter(k => !STEP_FIELDS.has(k));
  if (unknown.length) throw new InputError(`${where} has a field Assay doesn't know: ${unknown[0].slice(0, 40)}.`);
  const acts = ACTIONS.filter(a => s[a] !== undefined);
  if (acts.length !== 1) throw new InputError(`${where} must do exactly one thing (${ACTIONS.join(', ')}).`);
  const step: FlowStep = {};
  const a = acts[0];
  if (a === 'goto') { if (typeof s.goto !== 'string') throw new InputError(`${where}: goto takes a path.`); step.goto = checkPagePath(s.goto); }
  else if (a === 'back') { if (s.back !== true) throw new InputError(`${where}: back is true or left out.`); step.back = true; }
  else if (a === 'press') { if (typeof s.press !== 'string' || !KEYS.includes(s.press)) throw new InputError(`${where}: press takes one of ${KEYS.join(', ')}.`); step.press = s.press; }
  else if (a === 'type') { if (typeof s.type !== 'string' || s.type.length > MAX_TEXT) throw new InputError(`${where}: type takes text up to ${MAX_TEXT} characters.`); step.type = s.type; }
  else { const v = s[a]; if (!isText(v, MAX_SELECTOR)) throw new InputError(`${where}: ${a} takes a selector or text=… up to ${MAX_SELECTOR} characters.`); step[a] = v; }
  if (s.double !== undefined) { if (a !== 'click' || typeof s.double !== 'boolean') throw new InputError(`${where}: double goes only with click.`); if (s.double) step.double = true; }
  if (s.into !== undefined) { if (a !== 'type' || !isText(s.into, MAX_SELECTOR)) throw new InputError(`${where}: into goes only with type, as a selector.`); step.into = s.into; }
  if (s.timeoutMs !== undefined) { if (typeof s.timeoutMs !== 'number' || !Number.isInteger(s.timeoutMs) || s.timeoutMs < 1 || s.timeoutMs > 60_000) throw new InputError(`${where}: timeoutMs is a whole number from 1 to 60000.`); step.timeoutMs = s.timeoutMs; }
  return step;
}

function checkFlow(raw: unknown, n: number): Flow {
  const where = `Flow ${n}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`${where} is not a flow.`);
  const f = raw as Record<string, unknown>;
  if (f.assay !== 'flow/1') throw new InputError(`${where} must say "assay": "flow/1".`);
  const unknown = Object.keys(f).filter(k => !['assay', 'name', 'start', 'steps'].includes(k));
  if (unknown.length) throw new InputError(`${where} has a field Assay doesn't know: ${unknown[0].slice(0, 40)}.`);
  if (f.name !== undefined && !isText(f.name, 120)) throw new InputError(`${where}: name is text up to 120 characters.`);
  if (typeof f.start !== 'string') throw new InputError(`${where}: start is the path the flow begins on, like /cart.`);
  if (!Array.isArray(f.steps) || f.steps.length > MAX_STEPS) throw new InputError(`${where}: steps is a list of at most ${MAX_STEPS}.`);
  return { name: (f.name as string | undefined) ?? `Flow ${n}`, start: checkPagePath(f.start), steps: f.steps.map((s, i) => checkStep(s, `${where}, step ${i + 1}`)), skipped: 0 };
}

/** A selector from a Chrome Recorder step: the first CSS one, else its accessible name or text as text=… */
function recorderSelector(sel: unknown): string | null {
  if (!Array.isArray(sel)) return null;
  const flat = sel.map(s => (Array.isArray(s) ? s : [s])).filter(s => s.length === 1 && typeof s[0] === 'string').map(s => s[0] as string);
  const css = flat.find(s => !/^(?:aria|xpath|pierce|text)\//.test(s));
  if (css && css.length <= MAX_SELECTOR) return css;
  const named = flat.find(s => /^(?:aria|text)\//.test(s));
  if (named) { const t = named.replace(/^(?:aria|text)\//, '').replace(/\[role=.*\]$/, '').trim(); if (t && t.length <= MAX_SELECTOR - 5) return `text=${t}`; }
  return null;
}

/** A recording from Chrome DevTools' Recorder panel (its JSON export), turned into a flow. Steps with no equivalent are counted, not guessed. */
function fromRecorder(doc: { title?: unknown; steps: unknown[] }): Flow {
  if (doc.steps.length > MAX_STEPS * 2) throw new InputError(`The recording has more than ${MAX_STEPS * 2} steps.`);
  const steps: FlowStep[] = [];
  let start: string | null = null, skipped = 0;
  for (const raw of doc.steps) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const sel = recorderSelector(s.selectors);
    if (s.type === 'navigate' && typeof s.url === 'string') {
      let u: URL;
      try { u = new URL(s.url); } catch { skipped++; continue; }
      const p = checkPagePath(u.pathname || '/');
      if (start === null) start = p; else steps.push({ goto: p });
    } else if ((s.type === 'click' || s.type === 'doubleClick') && sel) steps.push(s.type === 'doubleClick' ? { click: sel, double: true } : { click: sel });
    else if (s.type === 'change' && sel && typeof s.value === 'string' && s.value.length <= MAX_TEXT) steps.push({ type: s.value, into: sel });
    else if (s.type === 'keyDown' && typeof s.key === 'string' && KEYS.includes(s.key === ' ' ? 'Space' : s.key)) steps.push({ press: s.key === ' ' ? 'Space' : s.key });
    else if (s.type === 'waitForElement' && sel) steps.push({ waitFor: sel });
    else if (s.type !== 'keyUp') skipped++;
  }
  if (start === null) throw new InputError('The recording never opens a page (it has no navigate step).');
  if (steps.length > MAX_STEPS) throw new InputError(`The recording has more than ${MAX_STEPS} steps Assay can use.`);
  return { name: isText(doc.title, 120) ? doc.title : 'Recording', start, steps, skipped };
}

/**
 * Flows from a file: one flow (`"assay": "flow/1"`), a list of them, or a recording exported from Chrome DevTools' Recorder panel.
 * Every step is checked; a file with one wrong step is refused whole, with where it is wrong.
 */
export function readFlows(file: string): Flow[] {
  const doc = parseJson(readInputFile(file, 2 * 1024 * 1024, 'flow file'), 'flow file');
  if (Array.isArray(doc)) {
    if (!doc.length || doc.length > 50) throw new InputError('A list of flows has 1 to 50 flows.');
    return doc.map((f, i) => checkFlow(f, i + 1));
  }
  const d = doc as Record<string, unknown>;
  if (d && typeof d === 'object' && d.assay === undefined && Array.isArray(d.steps) && d.steps.some(s => s && typeof s === 'object' && 'type' in (s as object))) {
    return [fromRecorder(d as { title?: unknown; steps: unknown[] })];
  }
  return [checkFlow(doc, 1)];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A schema, with a local `$ref` (`#/components/schemas/X`, `#/definitions/X`) followed up to three times. */
function resolveSchema(doc: Record<string, unknown>, schema: unknown): Record<string, unknown> | null {
  let s = obj(schema);
  for (let i = 0; i < 3 && s && typeof s.$ref === 'string'; i++) {
    let cur: unknown = doc;
    for (const part of s.$ref.replace(/^#\//, '').split('/')) cur = obj(cur)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    s = obj(cur);
  }
  return s;
}

/** The JSON body an operation takes: its top-level properties by name and type (OpenAPI 3 `requestBody`, Swagger 2 `in: body`). */
function bodyFields(doc: Record<string, unknown>, op: unknown): BodyField[] | undefined {
  const o = obj(op);
  if (!o) return undefined;
  let schema: unknown;
  const content = obj(obj(o.requestBody)?.content);
  if (content) schema = obj(content['application/json'] ?? content['application/*+json'] ?? content['*/*'])?.schema;
  else if (Array.isArray(o.parameters)) schema = o.parameters.map(obj).find(p => p?.in === 'body')?.schema;
  const s = resolveSchema(doc, schema);
  const props = obj(s?.properties);
  if (!s || !props) return undefined;
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
  const out: BodyField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (out.length >= 30 || name.length > 60 || !/^[\w.$-]+$/.test(name)) continue;
    const p = resolveSchema(doc, raw);
    if (p?.readOnly === true) continue;
    const t = typeof p?.type === 'string' ? p.type : '';
    out.push({ name, type: (['string', 'number', 'integer', 'boolean', 'array', 'object'] as const).find(x => x === t) ?? 'other', required: required.has(name) });
  }
  return out.length ? out : undefined;
}

/** The base path an OpenAPI 3 `servers` entry or a Swagger 2 `basePath` puts in front of every path. */
function specBase(doc: Record<string, unknown>): string {
  if (typeof doc.basePath === 'string') return doc.basePath.replace(/\/+$/, '');
  const servers = doc.servers;
  if (Array.isArray(servers) && servers[0] && typeof (servers[0] as { url?: unknown }).url === 'string') {
    const raw = (servers[0] as { url: string }).url;
    try { return new URL(raw, 'http://x').pathname.replace(/\/+$/, ''); } catch { return ''; }
  }
  return '';
}

/** Endpoints from an OpenAPI 3 or Swagger 2 document, JSON or YAML. `name` is only for messages and for telling YAML from JSON. */
export function readOpenApiText(text: string, name: string): EndpointEntry[] {
  let doc: unknown;
  if (/\.ya?ml$/i.test(name) || !/^\s*[{[]/.test(text)) {
    try { doc = parseYaml(text); } catch (e) { throw new InputError(`${name} is not YAML Assay can read: ${(e as Error).message}`); }
  } else doc = parseJson(text, `OpenAPI file ${name}`);
  const d = doc as Record<string, unknown> | null;
  const isSpec = !!d && typeof d === 'object' && ((typeof d.openapi === 'string' && d.openapi.startsWith('3')) || d.swagger === '2.0' || d.swagger === 2);
  if (!isSpec) throw new InputError(`${name} is not an OpenAPI 3 or Swagger 2 document.`);
  const paths = d!.paths;
  if (!paths || typeof paths !== 'object') return [];
  const base = specBase(d!);
  const out: EndpointEntry[] = [];
  for (const [p, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!p.startsWith('/') || !item || typeof item !== 'object') continue;
    for (const m of HTTP_METHODS) {
      if ((item as Record<string, unknown>)[m] === undefined) continue;
      const body = bodyFields(d!, (item as Record<string, unknown>)[m]);
      out.push({ method: m.toUpperCase(), path: `${base}${p}` || '/', from: ['openapi'], file: name, ...(body ? { body } : {}) });
      if (out.length >= 2000) return out;
    }
  }
  return out;
}

export function readOpenApi(file: string): EndpointEntry[] {
  return readOpenApiText(readInputFile(file, 5 * 1024 * 1024, 'OpenAPI file'), path.basename(file));
}
