import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '@haithamexe/plainkit/yaml';
import type { FileDiff } from '../diff.js';

/**
 * Text the page shows that isn't in the project's translation files (D63), taken over from a sister tool's Languages check.
 * The files are JSON, YAML or .po in folders named like locales/, i18n/, messages/; placeholders ({{x}}, {x}, %s, :name, <0>)
 * match anything and ICU plurals become their options, so a translation with its values filled in still counts. Text that is
 * data (numbers, codes, emails, addresses, what the page's JSON script tags hold) never counts. `look` reports only what is new
 * at the head and was written by a changed line, so text that comes from an API or was already there is left alone.
 */

export const TRANSLATION_LIBRARIES = ['i18next', 'react-i18next', 'next-i18next', 'next-intl', 'react-intl', 'vue-i18n', '@lingui/core', '@lingui/react', 'svelte-i18n', '@ngx-translate/core', '@angular/localize', 'typesafe-i18n', '@inlang/paraglide-js', 'rosetta', 'i18n-js', '@formatjs/intl', 'nuxt-i18n', '@nuxtjs/i18n', 'react-native-localize', 'node-polyglot'];
const LOCALE_DIR = /^(locales?|i18n|lang|langs|languages|translations?|messages|intl|l10n)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.output', 'out', 'coverage', '.turbo', '.cache', 'vendor', '.venv', 'venv', 'target']);
const MAX_FILE = 2 * 1024 * 1024;

const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return undefined; } };

/** The translation library the project's package.json names, if any. */
export function translationLibrary(dir: string): string | undefined {
  const pkg = readJson(path.join(dir, 'package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return TRANSLATION_LIBRARIES.find(l => l in deps);
}

/** JSON, YAML and .po files in folders named like locales/, i18n/, messages/ (never node_modules or a build), at most 200. */
export function findTranslationFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number, inLocale: boolean): void => {
    if (depth > 6 || out.length >= 200) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        visit(p, depth + 1, inLocale || LOCALE_DIR.test(e.name));
      } else if (e.isFile() && inLocale && /\.(json|ya?ml|po)$/i.test(e.name)) {
        try { if (fs.statSync(p).size <= MAX_FILE) out.push(p); } catch { /* gone */ }
      }
    }
  };
  visit(dir, 0, false);
  return out.sort();
}

function leaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 12 || out.length > 50_000) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) leaves(v, out, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out, depth + 1);
}

/** Every string in the files: values of JSON and YAML, msgid and msgstr of .po. A file that doesn't parse is left out. */
export function readTranslations(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { continue; }
    if (/\.po$/i.test(f)) {
      for (const m of text.matchAll(/^(?:msgid|msgstr(?:\[\d+\])?)\s+"((?:[^"\\]|\\.)*)"/gm)) if (m[1]) out.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'));
      continue;
    }
    try { leaves(/\.json$/i.test(f) ? JSON.parse(text) : parseYaml(text), out); } catch { /* left out */ }
  }
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a page's text comes from the translations: the same text, or a translation with its placeholders filled in. */
export function translationMatcher(values: string[]): (text: string) => boolean {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const HOLE = /\{\{[^}]*\}\}|\{[^{}]*\}|%\d*\$?[sdif@]|<\/?\d+>|<\/?[a-z][\w-]*\/?>|(?<![\w:]):[a-z]\w*/gi;
  // ICU plurals and selects: each option is a text of its own ("# items"), and the whole a hole.
  const ICU = /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,((?:[^{}]|\{[^{}]*\})*)\}/i;
  const all: string[] = [];
  for (const v of values) {
    let rest = v;
    for (let i = 0, m = ICU.exec(rest); m && i < 20; i++, m = ICU.exec(rest)) {
      for (const o of m[1].matchAll(/\{([^{}]*)\}/g)) all.push(o[1].replace(/#/g, '{n}'));
      rest = rest.replace(m[0], '{x}');
    }
    all.push(rest);
  }
  for (const v of all) {
    const n = norm(v);
    if (!n || !/[a-z]{2}/i.test(n)) continue;
    exact.add(n);
    HOLE.lastIndex = 0;
    if (HOLE.test(n) && patterns.length < 5000) {
      const re = n.split(HOLE).map(escape).join('.*?');
      if (re.replace(/\.\*\?/g, '').trim().length >= 2) patterns.push(new RegExp(`^${re}$`, 's'));
      // The fixed parts on their own: an ICU plural's "items" shown next to its number.
      for (const p of n.split(HOLE)) if (/[a-z]{3}/i.test(p)) exact.add(p.trim());
    }
  }
  return (text: string): boolean => {
    const n = norm(text);
    if (exact.has(n)) return true;
    // A translation with a number or a symbol next to it: "Total: 40 €", "3 items".
    const bare = n.replace(/[\d.,:;!?()[\]%€$£¥+\-–—/*#@|·•…"'“”‘’«»]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (bare && exact.has(bare)) return true;
    return patterns.some(re => re.test(n));
  };
}

/** Text that is data, not words to translate: numbers, dates, prices, codes, emails, addresses, file names. */
export function looksLikeData(text: string): boolean {
  const t = text.trim();
  if (!/[A-Za-zÀ-ž]{2}/.test(t)) return true;
  if (/^\S+@\S+\.\S+$/.test(t) || /^(https?:\/\/|www\.)/i.test(t) || /^[\w./-]+\.(js|ts|tsx|css|png|jpe?g|svg|json)$/i.test(t)) return true;
  if (/^[A-Z0-9_-]{2,}$/.test(t) && /\d/.test(t)) return true;
  if (/^#?[A-Za-z]*\d[\w-]*$/.test(t)) return true;
  return false;
}

/** What the page shows that a person reads: each element's own text and a few attributes, once each, at most 400. Runs in the page. */
export const TEXTS_SRC = String.raw`(function () {
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SAMP|TEMPLATE|svg|SVG)$/;
  var seen = {}, list = [];
  function add(t, where) { t = (t || '').replace(/\s+/g, ' ').trim(); if (t.length < 2 || t.length > 300 || !/[A-Za-zÀ-ž]{2}/.test(t) || seen[t]) return; seen[t] = 1; list.push({ text: t, where: where }); }
  function visible(e) { var r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }
  var w = document.body ? document.createTreeWalker(document.body, 1) : null, e;
  while (w && (e = w.nextNode()) && list.length < 400) {
    if (SKIP.test(e.tagName) || e.getAttribute('translate') === 'no' || e.classList.contains('notranslate') || !visible(e)) continue;
    var own = '';
    for (var c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
    add(own, e.tagName.toLowerCase());
    ['placeholder', 'aria-label', 'alt', 'title'].forEach(function (a) { if (e.hasAttribute(a)) add(e.getAttribute(a), e.tagName.toLowerCase() + ' ' + a); });
    if (e.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(e.type)) add(e.value, 'button');
  }
  var data = '';
  Array.prototype.forEach.call(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]'), function (s) { if (data.length < 2e6) data += (s.textContent || '') + ' '; });
  return { texts: list, data: data.slice(0, 2e6) };
})()`;

export interface PageText { text: string; where: string }

/** The page's texts that aren't translated and aren't data. Short words count as data only as a whole value ("ok" is inside "token"). */
export function untranslatedTexts(texts: PageText[], data: string, isTranslated: (t: string) => boolean): PageText[] {
  const d = data.toLowerCase();
  return texts.filter(t => {
    if (looksLikeData(t.text)) return false;
    const n = norm(t.text);
    if (d && (n.length >= 8 ? d.includes(n) : d.includes(`"${n}"`))) return false;
    return !isTranslated(t.text);
  });
}

const NOT_SOURCE = /(^|\/)(locales?|i18n|translations?|messages|lang|langs|l10n|__tests__|tests?|spec|fixtures?|mocks?|__mocks__|stories)\/|\.(json|ya?ml|po|md|lock|snap|map)$|\.(test|spec|stories)\.[cm]?[jt]sx?$/i;

/** The first added line of a source file (not a translation file, a test, a fixture or data) that writes this text. */
export function addedLineWith(net: FileDiff[], text: string): { file: string; line: number } | null {
  if (text.length < 3) return null;
  for (const f of net) {
    if (f.binary || f.status === 'deleted' || NOT_SOURCE.test(f.path.replace(/\\/g, '/'))) continue;
    for (const h of f.hunks) for (const l of h.lines) if (l.t === '+' && l.n !== null && l.text.includes(text)) return { file: f.path, line: l.n };
  }
  return null;
}

/** Labels for where a text was: "a button", "a link". */
const TAGS: Record<string, string> = { img: 'an image', a: 'a link', button: 'a button', label: 'a label', p: 'a paragraph', li: 'a list item', td: 'a table cell', th: 'a column heading', option: 'an option', h1: 'a heading', h2: 'a heading', h3: 'a heading', h4: 'a heading', title: 'the title', nav: 'the navigation', summary: 'a summary', legend: 'a legend', caption: 'a caption' };
export const whereWords = (where: string): string => {
  const [tag, attr] = where.split(' ');
  const t = TAGS[tag] ?? 'a text';
  return attr ? `${t}’s ${attr}` : t;
};
