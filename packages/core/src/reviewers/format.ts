import type { Case, Panel } from '../types.js';
import { ATTACK_MIN_BUDGET, k, openCross, statusOf } from './plan.js';

/** The panel as text for an agent or a terminal: who runs, what it costs, what each has done, and exactly what to do next. */
export function panelText(c: Case, p: Panel, o: { open?: boolean } = {}): string {
  if (o.open !== false) openCross(c);
  const s = statusOf(c.panel ?? p);
  const l: string[] = [];
  l.push(p.budget === 0 ? `Reviewer panel for case ${c.id} · free checks only: the reviewers stay off.` : `Reviewer panel for case ${c.id} · budget ${k(p.budget)} tokens · about ${k(p.estimate.total)} (reviewers ${k(p.estimate.specialists)}${p.cross.run ? `, cross-examination ${k(p.cross.tokens)}` : ''}${p.attack?.run ? `, attack pass ${k(p.attack.tokens)}` : ''})`);
  if (p.request) l.push(`Request: ${p.request.length > 160 ? `${p.request.slice(0, 160)}…` : p.request}`);
  l.push('');
  for (const r of p.reviewers) {
    const state = !r.run ? '' : r.state === 'reported' ? `  reported: ${r.claims} claim${r.claims === 1 ? '' : 's'}, ${r.kept + r.merged} kept, ${r.dropped} dropped` : r.state === 'briefed' ? '  briefed, working' : '  waiting';
    l.push(`${r.run ? 'RUN ' : 'skip'}  ${r.name.padEnd(19)} ${r.run ? `~${k(r.tokens)}`.padEnd(7) : '       '} ${r.run ? r.why : `${r.skip === 'budget' ? '' : r.skip === 'off' ? '' : 'not needed: '}${r.why}`}${state}`);
  }
  const a = p.attack;
  // The attack pass is for big budgets: below that it is not on offer, so it is not listed as left out.
  if (a && (a.run || p.budget >= ATTACK_MIN_BUDGET)) {
    const state = !a.run ? '' : a.state === 'reported' ? `  reported: ${a.claims} claim${a.claims === 1 ? '' : 's'}, ${a.kept + a.merged} kept, ${a.dropped} dropped` : a.state === 'briefed' ? '  briefed, working' : '  waiting';
    l.push(`${a.run ? 'RUN ' : 'skip'}  ${'Attack'.padEnd(19)} ${a.run ? `~${k(a.tokens)}`.padEnd(7) : '       '} ${a.run ? a.why : `${a.skip === 'not-needed' ? 'not needed: ' : ''}${a.why}`}${state}`);
  }
  const bl = p.baseline;
  if (bl?.run) {
    const state = bl.state === 'reported' ? `  reported: ${bl.claims} claim${bl.claims === 1 ? '' : 's'}, ${bl.kept + bl.merged} kept, ${bl.dropped} dropped` : bl.state === 'briefed' ? '  briefed, working' : '  waiting';
    l.push(`RUN   ${'Plain review'.padEnd(19)} ${`~${k(bl.tokens)}`.padEnd(7)} ${bl.why}${state}`);
  }
  if (p.estimate.saved > 0) l.push('', `Not spent: about ${k(p.estimate.saved)} on lenses this change doesn't touch.`);
  const cross = c.panel?.cross;
  l.push('', `Where it stands: ${s.phase === 'off' ? 'not running' : s.phase}. ${s.next}`);
  if (s.phase === 'waiting' || s.phase === 'reviewing') {
    const todo = p.reviewers.filter(r => r.run && r.state !== 'reported');
    const attacking = !!(a?.run && a.state !== 'reported');
    const plain = !!(bl?.run && bl.state !== 'reported');
    l.push('', `Run it: start one sub-agent per reviewer still to report (${[...todo.map(r => r.lens as string), ...(attacking ? ['Attack'] : []), ...(plain ? ['Plain'] : [])].join(', ')}), in parallel, each told only:`, `  "You are the <lens> reviewer for case ${c.id}. Call reviewer_brief with case "${c.id}" and lens "<lens>", and do what it says."`, ...(attacking ? [`  and the attack pass: "You are the attacker for case ${c.id}. Call reviewer_brief with case "${c.id}" and lens "attack", and do what it says."`] : []), ...(plain ? [`  and the plain review: "You are the only reviewer of case ${c.id}. Call reviewer_brief with case "${c.id}" and lens "plain", and do what it says."`] : []), 'Don\'t show reviewers each other\'s output. Then call reviewers_plan again.');
  } else if (s.phase === 'cross' && cross && cross.state === 'open') {
    const todo = Object.keys(cross.assigned).filter(x => !cross.reported.includes(x));
    l.push('', `Cross-examination: start one sub-agent per examiner (${todo.join(', ')}), each told only:`, `  "You are the <lens> reviewer for case ${c.id}. Call reviewer_brief with case "${c.id}", lens "<lens>" and round 2, and do what it says."`, 'Then call reviewers_plan again.');
  }
  if (cross && cross.disputes.length) l.push('', `Disputed: ${cross.disputes.map(d => `${d.finding} (by ${d.by}: ${d.reason.slice(0, 80)})`).join('; ')}`);
  return l.join('\n');
}
