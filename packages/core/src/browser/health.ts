import type { PageRequest } from '@haithamexe/plainkit/browser';
import type { PagePerf } from './inspect.js';

/**
 * Speed and calls, base against head (D62). Both come from a sister tool's per-commit page checks, made stricter here
 * because a finding is proof: a dev server is noisy, so a page counts as slower only when the median of three loads moved
 * by a clear margin and every load at the head was slower than every load at the base. Calls are compared by method and
 * path with ids folded (the two ends run on different ports), and only data calls count (fetch, XHR, event streams,
 * sockets), because a dev server's module graph changes with every edit.
 */

const median = (xs: number[]): number | undefined => {
  const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return undefined;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 1000) / 1000;
};

/** The middle of several loads, field by field. */
export function medianPerf(runs: PagePerf[]): PagePerf | undefined {
  if (!runs.length) return undefined;
  const pick = (k: keyof PagePerf): number | undefined => median(runs.map(r => r[k]).filter((v): v is number => typeof v === 'number'));
  return { loadMs: pick('loadMs'), lcpMs: pick('lcpMs'), tbtMs: pick('tbtMs'), cls: pick('cls'), jsBytes: pick('jsBytes'), requests: pick('requests') };
}

export const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtKb = (b: number): string => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

/** "largest paint 1.2 s → 1.9 s" when the head is clearly and consistently slower; nothing otherwise. */
export function slowerThan(head: PagePerf[], base: PagePerf[]): string | undefined {
  if (head.length < 2 || base.length < 2) return undefined;
  const out: string[] = [];
  const series = (runs: PagePerf[], k: keyof PagePerf): number[] => runs.map(r => r[k]).filter((v): v is number => typeof v === 'number');
  const apart = (k: keyof PagePerf): boolean => { const h = series(head, k), b = series(base, k); return h.length > 0 && b.length > 0 && Math.min(...h) > Math.max(...b); };
  const time = (label: string, k: 'lcpMs' | 'loadMs', min = 300): boolean => {
    const h = median(series(head, k)), b = median(series(base, k));
    if (h === undefined || b === undefined || b <= 0 || h - b < min || h < b * 1.3 || !apart(k)) return false;
    out.push(`${label} ${fmtMs(b)} → ${fmtMs(h)}`);
    return true;
  };
  if (!time('largest paint', 'lcpMs')) time('load', 'loadMs');
  const ht = median(series(head, 'tbtMs')), bt = median(series(base, 'tbtMs'));
  if (ht !== undefined && bt !== undefined && ht - bt >= 200 && apart('tbtMs')) out.push(`main thread blocked ${fmtMs(bt)} → ${fmtMs(ht)}`);
  const hc = median(series(head, 'cls')), bc = median(series(base, 'cls'));
  if (hc !== undefined && bc !== undefined && hc - bc >= 0.1 && apart('cls')) out.push(`layout shift ${bc} → ${hc}`);
  return out.length ? out.join(', ') : undefined;
}

/** "JavaScript 412 KB → 498 KB" when the head fetches clearly more script (the same build tool at both ends, so this barely varies). */
export function heavierThan(head: PagePerf | undefined, base: PagePerf | undefined): string | undefined {
  if (!head?.jsBytes || !base?.jsBytes) return undefined;
  const d = head.jsBytes - base.jsBytes;
  return d >= 20 * 1024 && head.jsBytes >= base.jsBytes * 1.1 ? `JavaScript ${fmtKb(base.jsBytes)} → ${fmtKb(head.jsBytes)}` : undefined;
}

export interface CallSummary {
  /** "GET /api/orders/{id}", or "GET api.example.com/v1/x" for another host. */
  key: string;
  count: number;
  /** What it answered: "200", "404", "failed", "?" (still waiting when the page settled). */
  statuses: string[];
}

const DATA = new Set(['Fetch', 'XHR', 'EventSource', 'WebSocket', 'Ping']);
const DEV = /^\/(@vite\/|@id\/|@fs\/|node_modules\/|__vite|_next\/(static|webpack)|sockjs-node|__webpack_hmr|favicon\.ico)/;
const ID = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{32,36}|[A-Za-z0-9_-]{20,})$/;
export const foldPath = (p: string): string => p.split('/').map(s => (s && ID.test(s) && /\d/.test(s) ? '{id}' : s)).join('/');

/** The data calls a page made, by method and folded path, with how often and what they answered. Never a query value, a header or a body. */
export function callsOf(requests: PageRequest[], origin: string): CallSummary[] {
  const map = new Map<string, CallSummary>();
  for (const r of requests) {
    if (!DATA.has(r.type)) continue;
    let u: URL;
    try { u = new URL(r.url); } catch { continue; }
    if (DEV.test(u.pathname)) continue;
    const where = u.origin === origin ? foldPath(u.pathname) : `${u.host}${foldPath(u.pathname)}`;
    const key = `${r.method} ${where}`;
    const s = map.get(key) ?? { key, count: 0, statuses: [] };
    s.count++;
    const status = r.status ? String(r.status) : r.error ? 'failed' : '?';
    if (!s.statuses.includes(status)) s.statuses.push(status);
    map.set(key, s);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface CallChange {
  kind: 'call-added' | 'call-removed' | 'call-count' | 'status' | 'warning-new' | 'warning-gone' | 'title';
  /** worse: more calls, a call that now fails, a new warning. better: the opposite. change: neither. */
  tone: 'worse' | 'better' | 'change';
  text: string;
  /** The call it is about, for anchoring and replay. */
  key?: string;
}

const bad = (statuses: string[]): boolean => statuses.some(s => s === 'failed' || Number(s) >= 400);
const shape = (s: string): string => s.split('\n')[0].replace(/https?:\/\/[^/\s]+/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);

/** What changed underneath between the page at the base and at the head: its calls, its warnings, its title. */
export function compareCalls(base: { calls: CallSummary[]; warnings: string[]; title?: string }, head: { calls: CallSummary[]; warnings: string[]; title?: string }): CallChange[] {
  const out: CallChange[] = [];
  const bm = new Map(base.calls.map(c => [c.key, c]));
  const hm = new Map(head.calls.map(c => [c.key, c]));
  for (const c of head.calls) {
    const old = bm.get(c.key);
    if (!old) { out.push({ kind: 'call-added', tone: bad(c.statuses) ? 'worse' : 'change', text: `new call: ${c.key}${c.count > 1 ? ` (${c.count} times)` : ''} → ${c.statuses.join(', ')}`, key: c.key }); continue; }
    if (old.count !== c.count) out.push({ kind: 'call-count', tone: c.count > old.count ? 'worse' : 'better', text: `${c.key} is called ${c.count} time${c.count === 1 ? '' : 's'}, was ${old.count}`, key: c.key });
    if (old.statuses.join() !== c.statuses.join() && !c.statuses.includes('?') && !old.statuses.includes('?')) {
      out.push({ kind: 'status', tone: bad(c.statuses) && !bad(old.statuses) ? 'worse' : !bad(c.statuses) && bad(old.statuses) ? 'better' : 'change', text: `${c.key} answers ${c.statuses.join(', ')}, was ${old.statuses.join(', ')}`, key: c.key });
    }
  }
  for (const c of base.calls) if (!hm.has(c.key)) out.push({ kind: 'call-removed', tone: 'change', text: `no longer called: ${c.key}`, key: c.key });
  const bw = new Map(base.warnings.map(w => [shape(w), w]));
  const hw = new Map(head.warnings.map(w => [shape(w), w]));
  for (const [k, w] of hw) if (!bw.has(k)) out.push({ kind: 'warning-new', tone: 'worse', text: `new console warning: ${w.slice(0, 200)}`, key: w.slice(0, 300) });
  for (const [k, w] of bw) if (!hw.has(k)) out.push({ kind: 'warning-gone', tone: 'better', text: `warning gone: ${w.slice(0, 200)}` });
  if ((base.title ?? '') !== (head.title ?? '')) out.push({ kind: 'title', tone: 'change', text: `title "${(head.title ?? '').slice(0, 80)}", was "${(base.title ?? '').slice(0, 80)}"` });
  const order = { worse: 0, change: 1, better: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
