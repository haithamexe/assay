import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assayPath, writeFileAtomic } from '../config.js';
import type { Lens } from '../types.js';

const LENSES: Lens[] = ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Scope', 'Performance'];

/**
 * Standards packs are plain JSON files (D30): the ones that ship with Assay in packages/core/assets/packs, and yours in
 * ~/.assay/packs. A pack of yours with the same id wins. A new edition of a standard is a file update, not a release.
 * Pack files are read as data and checked field by field; a bad one is skipped and reported, never half-loaded.
 */
export interface PackRule {
  /** Unique inside its pack. The entry's id is `<pack>/<rule>`. */
  id: string;
  name: string;
  ref: string | null;
  /** Evidence sources of Assay's own checks this rule is about ("rule:html-injection", "browser:contrast", "fact:*"). Empty: a question for a reviewer. */
  sources: string[];
  question: string | null;
  /** Which reviewer a question is for. Without one, Correctness. */
  lens: Lens;
  langs: string[];
  bad: string | null;
  good: string | null;
}

export interface Pack {
  id: string;
  name: string;
  edition: string | null;
  source: string | null;
  note: string;
  /** Whether it is on in a repository that hasn't chosen. */
  on: boolean;
  rules: PackRule[];
  origin: 'bundled' | 'yours';
  file: string;
}

const MAX_FILE = 256 * 1024;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RULE_ID = /^[a-z0-9][a-z0-9.-]{0,60}$/;
const SOURCE = /^[a-z]+:(?:[A-Za-z0-9._-]+\*?|\*)$/;

export const bundledPacksDir = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'packs');
export const packsDir = (): string => assayPath('packs');

function str(v: unknown, what: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${what} is missing`);
    return null;
  }
  if (typeof v !== 'string') throw new Error(`${what} must be text`);
  if (v.length > max) throw new Error(`${what} is longer than ${max} characters`);
  return v;
}

function list(v: unknown, what: string, max: number, each: (s: string) => void): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
  if (v.length > max) throw new Error(`${what} has more than ${max} items`);
  return v.map(x => {
    if (typeof x !== 'string' || !x || x.length > 80) throw new Error(`${what} holds something that isn't short text`);
    each(x);
    return x;
  });
}

/** Checks a parsed pack file. Throws a sentence that says what is wrong and where. */
export function parsePack(raw: unknown, file: string, origin: Pack['origin']): Pack {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a pack is a JSON object');
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 'id', 41, true) as string;
  if (!PACK_ID.test(id)) throw new Error(`id "${id}" must be lower case letters, digits and dashes`);
  const source = str(o.source, 'source', 200);
  if (source && !/^https?:\/\//.test(source)) throw new Error('source must be an http or https address');
  if (!Array.isArray(o.rules) || !o.rules.length) throw new Error('rules must be a list with at least one rule');
  if (o.rules.length > 300) throw new Error('a pack can hold up to 300 rules');
  const seen = new Set<string>();
  const rules = o.rules.map((r, i): PackRule => {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`${at} must be an object`);
    const x = r as Record<string, unknown>;
    const rid = str(x.id, `${at} id`, 61, true) as string;
    if (!RULE_ID.test(rid)) throw new Error(`${at}: id "${rid}" must be lower case letters, digits, dots and dashes`);
    if (seen.has(rid)) throw new Error(`${at}: id "${rid}" is used twice`);
    seen.add(rid);
    const sources = list(x.sources, `${rid} sources`, 30, s => { if (!SOURCE.test(s)) throw new Error(`${rid}: "${s}" is not an evidence source like rule:eval or browser:contrast`); });
    const question = str(x.question, `${rid} question`, 400);
    if (!sources.length && !question) throw new Error(`${rid}: give it sources (a check can decide) or a question (a reviewer decides)`);
    const lens = str(x.lens, `${rid} lens`, 20) ?? 'Correctness';
    if (!LENSES.includes(lens as Lens)) throw new Error(`${rid}: lens "${lens}" is not one of ${LENSES.join(', ')}`);
    return {
      id: rid, name: str(x.name, `${rid} name`, 140, true) as string, ref: str(x.ref, `${rid} ref`, 90), sources, question, lens: lens as Lens,
      langs: list(x.langs, `${rid} langs`, 20, () => undefined), bad: str(x.bad, `${rid} bad`, 200), good: str(x.good, `${rid} good`, 200)
    };
  });
  return {
    id, name: str(o.name, 'name', 90, true) as string, edition: str(o.edition, 'edition', 40), source,
    note: str(o.note, 'note', 500) ?? '', on: o.on !== false, rules, origin, file
  };
}

function readDir(dir: string, origin: Pack['origin'], into: Map<string, Pack>, problems: string[]): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch { return; }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      if (fs.statSync(file).size > MAX_FILE) throw new Error('the file is larger than 256 KB');
      const p = parsePack(JSON.parse(fs.readFileSync(file, 'utf8')), file, origin);
      into.set(p.id, p);
    } catch (err) {
      problems.push(`${origin === 'yours' ? file : n}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Every pack there is, bundled first, yours over them. A file that can't be read is listed in `problems`, not thrown. */
export function loadPacks(): { packs: Pack[]; problems: string[] } {
  const all = new Map<string, Pack>();
  const problems: string[] = [];
  readDir(bundledPacksDir(), 'bundled', all, problems);
  readDir(packsDir(), 'yours', all, problems);
  return { packs: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** Checks a file and copies it into your packs folder (under its own id, so importing again replaces it). */
export function importPack(file: string): Pack {
  const abs = path.resolve(file);
  if (fs.statSync(abs).size > MAX_FILE) throw new Error('That file is larger than 256 KB, so it is not a pack.');
  const text = fs.readFileSync(abs, 'utf8');
  const pack = parsePack(JSON.parse(text), abs, 'yours');
  const dest = path.join(packsDir(), `${pack.id}.json`);
  writeFileAtomic(dest, text);
  return { ...pack, file: dest };
}

/** An evidence source matches a pack's source when equal, or when the pack's ends in * and the rest is the start. */
export function sourceMatches(pattern: string, source: string): boolean {
  return pattern.endsWith('*') ? source.startsWith(pattern.slice(0, -1)) : pattern === source;
}
