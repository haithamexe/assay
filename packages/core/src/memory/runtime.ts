import { sha } from '../config.js';
import { clip, type Check, type RawFinding } from '../checks/types.js';
import { repoKey } from '../git.js';
import { isDemoPath, isGenerated, isTestPath, languageOf } from '../lang.js';
import { memoryFile, memoryVersion, openDb } from './db.js';
import { entryStructure, listEntries, type Entry } from './entries.js';
import { sourceMatches } from './packs.js';

/**
 * What memory changes about how a commit is analysed (D32, D33): which of Assay's own signals are switched off, and the patterns
 * this project learned. Both go into the analysis cache key (`digest`), so a commit is analysed again when they change and never
 * otherwise. With nothing switched off and nothing learned the digest is empty, and the caches of before stay valid.
 */
export interface MemoryRuntime {
  digest: string;
  /** True for a signal whose every entry is switched off. Proof is never muted: the caller only asks about findings with none. */
  isMuted(source: string): boolean;
  /** One check holding every learned pattern, or null when there are none. */
  learned: Check | null;
}

const NONE: MemoryRuntime = { digest: '', isMuted: () => false, learned: null };
const TTL_MS = 1500;
const AGE_MS = 10 * 60_000;
const memo = new Map<string, { at: number; v: number; rt: MemoryRuntime }>();
const aged = new Map<string, number>();

/** Only a signal can be switched off: `rule:`, `diff:` and the project's own patterns. A fact, a measurement or a failing test is never muted. */
const MUTABLE = /^(?:rule|diff|memory):/;
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|<!--)/;

interface Learned { id: string; name: string; re: RegExp; pattern: string; langs: string[]; lens: Entry['lens']; severity: Entry['severity']; good: string | null; fixes: number; example: Entry['examples'][number] | null }

function learnedCheck(list: Learned[]): Check {
  return ctx => {
    const out: RawFinding[] = [];
    for (const f of ctx.files) {
      if (f.binary || f.status === 'deleted' || isGenerated(f.path) || isTestPath(f.path) || isDemoPath(f.path)) continue;
      const lang = languageOf(f.path);
      if (!lang) continue;
      for (const e of list) {
        if (e.langs.length ? !e.langs.includes(lang) : lang === 'Markdown') continue;
        let n = 0;
        let last = -1;
        for (const h of f.hunks) for (const l of h.lines) {
          if (l.t !== '+' || l.n === null || l.text.length > 1500 || COMMENT.test(l.text) || !e.re.test(l.text)) continue;
          n++;
          if (n > 3) continue;
          const times = `${e.fixes} time${e.fixes === 1 ? '' : 's'}`;
          out.push({
            check: 'memory', key: `${e.id}:${f.path}:${l.n}`, title: e.name, lens: e.lens, severity: e.severity, file: f.path, line: l.n, side: 'added', text: l.text,
            evidence: [
              { kind: 'rule', source: `memory:${e.id}`, what: `Line ${l.n} matches a pattern this project keeps: ${clip(l.text.trim(), 90)}` },
              ...(e.fixes > 0 ? [{ kind: 'history' as const, source: 'history:fixes', what: `This project fixed the same pattern ${times} before${e.example ? ` (for example ${e.example.commit.slice(0, 7)} “${clip(e.example.subject, 60)}”)` : ''}.` }] : [])
            ],
            observed: [`Line ${l.n} matches “${e.name}”.`],
            inferred: [e.good ? `Earlier fixes replaced it with something like: ${clip(e.good, 90)}` : 'Code like this was changed back in this project before.']
          });
          last = out.length - 1;
        }
        if (n > 3 && last >= 0) out[last].observed.push(`${n - 3} more line${n - 3 > 1 ? 's' : ''} in this file match the same pattern.`);
      }
    }
    return out;
  };
}

export function memoryRuntime(repo: string): MemoryRuntime {
  try {
    if (!openDb()) return NONE;
    const key = `${memoryFile()}|${repoKey(repo)}`;
    const now = Date.now();
    const hit = memo.get(key);
    if (hit && hit.v === memoryVersion() && now - hit.at < TTL_MS) return hit.rt;
    // Time passing can expire an entry with nobody looking: check now and then.
    if (now - (aged.get(key) ?? 0) > AGE_MS) { aged.set(key, now); listEntries(repo); }
    const { entries } = entryStructure(repo);
    const referenced = new Set(entries.flatMap(e => e.sources).filter(s => MUTABLE.test(s) && !s.startsWith('memory:')));
    const active = new Set(entries.filter(e => e.on).flatMap(e => e.sources));
    const muted = [...referenced].filter(s => !active.has(s)).sort();
    const activeList = [...active];
    const learned: Learned[] = [];
    for (const e of entries) {
      if (e.kind !== 'learned' || !e.on || !e.pattern) continue;
      try { learned.push({ id: e.id, name: e.name, re: new RegExp(e.pattern.source, e.pattern.flags), pattern: e.pattern.source, langs: e.langs, lens: e.lens, severity: e.severity, good: e.good, fixes: e.fixes, example: e.examples[0] ?? null }); } catch { /* a pattern that no longer compiles is skipped */ }
    }
    const digest = muted.length || learned.length
      ? sha(JSON.stringify({ muted, learned: learned.map(l => [l.id, l.pattern, l.re.flags, l.langs, l.name, l.lens, l.severity, l.fixes, l.example?.commit ?? '']) }), 12)
      : '';
    const rt: MemoryRuntime = {
      digest,
      isMuted: s => muted.some(m => sourceMatches(m, s)) && !activeList.some(a => sourceMatches(a, s)),
      learned: learned.length ? learnedCheck(learned) : null
    };
    memo.set(key, { at: now, v: memoryVersion(), rt });
    return rt;
  } catch {
    return NONE;
  }
}
