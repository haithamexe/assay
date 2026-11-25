import { memory, repoRoot } from '@assay/core';
import { bold, dim, green, red, yellow } from './format.js';

type Flags = Record<string, string | true>;
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

export const MEMORY_HELP = `${bold('assay memory')}  what Assay remembers about this project

  assay memory                       what is in memory, and what is switched off
  assay memory list [--kind standard|learned|questions] [--all]
  assay memory show <entry>          one entry: its detector, its stats, an example
  assay memory packs                 the standards packs, on or off
  assay memory pack <id> on|off      switch a whole pack
  assay memory on|off <entry>        switch one entry (an entry that cries wolf switches itself off)
  assay memory mine [--limit <n>]    read the git history for the mistakes fix commits keep removing
  assay memory add <suggestion>      add one of those suggestions   (--name "your name for it")
  assay memory add --name "…" --pattern "…" [--langs "TypeScript,JavaScript"] [--good "…"] [--bad "…"] [--ref "…"]
  assay memory remove <L-n>          forget a learned entry
  assay memory questions [--langs "Python,CSS"]   what a reviewer should ask
  assay memory import <file>         check a pack file and copy it to your packs folder
`;

const statusWord = (e: memory.Entry): string => {
  const w = pad(e.status, 9);
  return e.status === 'active' ? green(w) : e.status === 'expiring' ? yellow(w) : e.status === 'expired' ? red(w) : dim(w);
};
const hitsText = (e: memory.Entry): string => (e.how === 'question' ? '' : `${e.stats.hits} hit${e.stats.hits === 1 ? '' : 's'}${e.stats.falseAlarms ? `, ${e.stats.falseAlarms} dismissed` : ''}`);

function entryLines(e: memory.Entry): string[] {
  const l = [`${bold(e.name)}  ${dim(e.id)}`, `  ${statusWord(e)} ${dim(e.kind === 'learned' ? 'learned here' : e.origin)}${e.ref ? dim(` · ${e.ref}`) : ''}`, `  Found by   ${e.detector}`];
  if (e.pattern) l.push(`  Pattern    ${e.pattern.source}${e.pattern.flags ? dim(` (flags: ${e.pattern.flags})`) : ''}`);
  if (e.how !== 'question') {
    const s = e.stats;
    l.push(`  Seen       ${s.hits} time${s.hits === 1 ? '' : 's'}${s.lastHit ? `, last ${s.lastHit.slice(0, 10)}` : ''}; ${s.falseAlarms} dismissed as false alarms`);
    l.push(`  12 weeks   ${s.weeks.map(w => (w === 0 ? '·' : w > 9 ? '+' : String(w))).join(' ')}`);
  }
  if (e.question) l.push(`  Ask        ${e.question}`);
  if (e.bad) l.push(`  Bad        ${e.bad}`);
  if (e.good) l.push(`  Good       ${e.good}`);
  if (e.status === 'expiring') l.push(dim(`  More than ${Math.round(memory.EXPIRY.falseShare * 100)}% of its alarms were dismissed. With no real hit for ${memory.EXPIRY.quietDays} days it switches itself off.`));
  if (e.status === 'expired') l.push(dim(`  It cried wolf and switched itself off. Turn it back on with: assay memory on ${e.id}`));
  if (e.examples.length) l.push(`  Fixed      ${e.fixes} time${e.fixes === 1 ? '' : 's'} before, e.g. ${e.examples[0].commit.slice(0, 7)} “${clip(e.examples[0].subject, 70)}”`);
  return l;
}

function find(repo: string, id: string | undefined): memory.Entry {
  if (!id) throw new Error('Which entry? assay memory list shows their ids.');
  const e = memory.listEntries(repo).find(x => x.id === id);
  if (!e) throw new Error(`There is no entry "${id}". assay memory list shows their ids.`);
  return e;
}

/** `assay memory …`. Returns the text to print, or the data when --json. */
export async function runMemory(args: string[], flags: Flags, repoArg: string, json: boolean): Promise<string> {
  const [sub = 'summary', ...rest] = args;
  if (sub === 'help') return MEMORY_HELP;
  const status = memory.memoryStatus();
  if (!status.available && sub !== 'packs' && sub !== 'questions' && sub !== 'import') return `${yellow('Memory is off.')} ${status.why}\n${dim('The standards packs can still be read: assay memory packs')}`;
  const repo = repoRoot(repoArg);
  const out = (data: unknown, text: string): string => (json ? JSON.stringify(data, null, 2) : text);

  if (sub === 'summary') {
    const entries = memory.listEntries(repo);
    const { packs, problems } = memory.listPacks(repo);
    const machine = entries.filter(e => e.how !== 'question');
    const lines = [
      `${bold('Memory')}  ${dim(repo)}`, '',
      `  ${entries.filter(e => e.kind === 'standard' && e.on).length} standard entries on, ${entries.filter(e => e.kind === 'learned').length} learned here, ${entries.filter(e => e.how === 'question' && e.on).length} questions for a reviewer`,
      `  ${machine.reduce((n, e) => n + e.stats.hits, 0)} hits seen in this project, ${machine.reduce((n, e) => n + e.stats.falseAlarms, 0)} dismissed as false alarms`,
      `  ${packs.filter(p => p.on).length} of ${packs.length} packs on`
    ];
    const odd = entries.filter(e => e.status === 'expiring' || e.status === 'expired');
    if (odd.length) { lines.push('', yellow('  Crying wolf:')); for (const e of odd) lines.push(`    ${statusWord(e)} ${clip(e.name, 56)} ${dim(`${e.id}  ${hitsText(e)}`)}`); }
    for (const p of problems) lines.push('', yellow(`  A pack file was skipped: ${p}`));
    lines.push('', dim('  assay memory list · packs · mine · questions · help'));
    return out({ entries: entries.length, packs: packs.length, problems }, lines.join('\n'));
  }

  if (sub === 'list') {
    const kind = str(flags, 'kind');
    let list = memory.listEntries(repo);
    if (kind === 'standard' || kind === 'learned') list = list.filter(e => e.kind === kind);
    else if (kind === 'questions') list = list.filter(e => e.how === 'question');
    else if (kind) throw new Error('--kind is standard, learned or questions');
    if (flags.all !== true) list = list.filter(e => e.on || e.status === 'expired');
    if (json) return JSON.stringify(list, null, 2);
    if (!list.length) return dim('Nothing here. assay memory mine can learn from this project’s history.');
    return list.map(e => `${pad(clip(e.id, 34), 34)} ${statusWord(e)} ${pad(clip(e.name, 52), 52)} ${dim(hitsText(e))}`).join('\n');
  }

  if (sub === 'show') { const e = find(repo, rest[0]); return out(e, entryLines(e).join('\n')); }

  if (sub === 'packs') {
    const { packs, problems } = memory.listPacks(repo);
    const lines = packs.map(p => `${p.on ? green('on ') : dim('off')}  ${pad(p.id, 16)} ${pad(clip(`${p.name}${p.edition ? ` (${p.edition})` : ''}`, 44), 44)} ${dim(`${p.checked} of ${p.rules} checked by Assay, ${p.questions} questions${p.origin === 'yours' ? ' · yours' : ''}`)}`);
    for (const p of problems) lines.push(yellow(`skipped: ${p}`));
    lines.push('', dim(`Add your own: put a pack file in ${memory.packsDir()} (or assay memory import <file>). A pack of yours with the same id replaces the bundled one.`));
    return out({ packs, problems }, lines.join('\n'));
  }

  if (sub === 'pack') {
    const [id, how] = rest;
    if (!id || (how !== 'on' && how !== 'off')) throw new Error('assay memory pack <id> on|off');
    memory.setPack(repo, id, how === 'on');
    return `${id}: ${how}`;
  }

  if (sub === 'on' || sub === 'off') {
    const e = find(repo, rest[0]);
    memory.setEntry(repo, e.id, sub === 'on');
    return `${e.id}: ${sub}`;
  }

  if (sub === 'mine') {
    const limit = str(flags, 'limit') ? Number(str(flags, 'limit')) : undefined;
    const r = await memory.mineHistory(repo, { limit, onProgress: m => { if (!json) console.error(dim(m)); } });
    const { added } = memory.lastMined(repo);
    if (json) return JSON.stringify({ ...r, added }, null, 2);
    const lines = [`Read ${r.commits} commits${r.truncated ? ` (the most recent; use --limit for more)` : ''}: ${bold(String(r.fixes))} are fixes${r.skipped ? `, ${r.skipped} bulk changes skipped` : ''}.`, ''];
    if (!r.candidates.length) lines.push('No pattern recurs enough to suggest. That is a fair answer: most fixes are logic, which has no shape to find.');
    for (const c of r.candidates) {
      lines.push(`${c.worth ? green('worth it') : dim('weak    ')} ${bold(c.token)}  ${dim(c.id)}${added[c.id] ? green('  added as ' + added[c.id]) : ''}`);
      lines.push(`         removed by ${c.fixes} fix commits${c.others ? `, and by ${c.others} other commit${c.others === 1 ? '' : 's'}` : ''}${c.replacedBy ? `; usually replaced by ${c.replacedBy}` : ''} ${dim(`[${c.langs.join(', ')}]`)}`);
      if (c.examples[0]) lines.push(`         ${dim(`${c.examples[0].commit.slice(0, 7)} “${clip(c.examples[0].subject, 60)}”`)}  ${clip(c.examples[0].bad, 60)}`);
    }
    if (r.candidates.length) lines.push('', dim('Add one with: assay memory add <suggestion id>   (nothing is added until you do)'));
    return lines.join('\n');
  }

  if (sub === 'add') {
    const id = rest[0];
    const name = str(flags, 'name');
    const e = id
      ? memory.addMined(repo, id, name)
      : memory.addLearned(repo, { name: name ?? '', pattern: str(flags, 'pattern') ?? '', langs: str(flags, 'langs')?.split(',').map(s => s.trim()).filter(Boolean), good: str(flags, 'good'), bad: str(flags, 'bad'), ref: str(flags, 'ref'), origin: 'Added by hand' });
    return out(e, `${green('Added')} ${e.id}  ${e.name}\n${dim('It runs on added lines in every case from now on. Commits you have already looked at are checked again, once.')}`);
  }

  if (sub === 'remove') {
    if (!rest[0]) throw new Error('assay memory remove <L-n>');
    memory.removeLearned(repo, rest[0]);
    return `${rest[0]}: removed`;
  }

  if (sub === 'questions') {
    const langs = str(flags, 'langs')?.split(',').map(s => s.trim()).filter(Boolean);
    const list = memory.questions(repo, langs);
    if (json) return JSON.stringify(list, null, 2);
    if (!list.length) return dim('No questions: every pack that holds some is off.');
    return list.map(q => `${bold(q.name)}  ${dim(`${q.origin}${q.ref ? ` · ${q.ref}` : ''}`)}\n  ${q.question}`).join('\n\n');
  }

  if (sub === 'import') {
    if (!rest[0]) throw new Error('assay memory import <pack file>');
    const p = memory.importPack(rest[0]);
    return `${green('Imported')} ${p.id}  ${p.name}${p.edition ? ` ${p.edition}` : ''}  ${dim(`${p.rules.length} rules, ${p.file}`)}`;
  }

  throw new Error(`Unknown memory command "${sub}". Try: assay memory help`);
}
