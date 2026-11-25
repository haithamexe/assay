import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Jobs } from '../jobs.js';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000): Promise<void> => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(10); };

test('jobs run one at a time, in order, and say what they are doing', async () => {
  const jobs = new Jobs();
  const order: string[] = [];
  const a = jobs.start({ kind: 'a', caseId: 'c-1', label: 'A' }, async ({ say }) => { order.push('a:start'); say('step 1'); await sleep(60); say('step 2'); order.push('a:end'); return 1; });
  const b = jobs.start({ kind: 'b', caseId: 'c-2', label: 'B' }, async () => { order.push('b:start'); return 2; });
  assert.equal(b.state, 'queued');
  assert.equal(jobs.busyCase('c-1'), true);
  assert.equal(jobs.busyCase('c-3'), false);
  await until(() => jobs.get(b.id)!.state === 'done');
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start'], 'the second waited for the first');
  assert.deepEqual(jobs.get(a.id)!.messages, ['step 1', 'step 2']);
  assert.equal(jobs.get(a.id)!.result, 1);
  assert.equal(jobs.get(a.id)!.state, 'done');
  assert.equal(jobs.active(), null);
  assert.equal(jobs.busyCase('c-1'), false);
});

test('a job that throws fails with its message and doesn’t stop the next one', async () => {
  const jobs = new Jobs();
  const bad = jobs.start({ kind: 'x', caseId: null, label: 'x' }, async () => { throw new Error('the tests could not start'); });
  const ok = jobs.start({ kind: 'y', caseId: null, label: 'y' }, async () => 'fine');
  await until(() => jobs.get(ok.id)!.state === 'done');
  assert.equal(jobs.get(bad.id)!.state, 'failed');
  assert.equal(jobs.get(bad.id)!.error, 'the tests could not start');
  assert.equal(jobs.get(ok.id)!.result, 'fine');
});

test('stopping: a queued job never starts, a running one is told to stop', async () => {
  const jobs = new Jobs();
  let sawAbort = false;
  const run = jobs.start({ kind: 'run', caseId: 'c-1', label: 'run' }, async ({ signal }) => { await new Promise<void>(r => signal.addEventListener('abort', () => { sawAbort = true; r(); })); return 'partial'; });
  let started = false;
  const queued = jobs.start({ kind: 'q', caseId: 'c-1', label: 'q' }, async () => { started = true; });
  await until(() => jobs.get(run.id)!.state === 'running');
  assert.equal(jobs.active()!.id, run.id);
  jobs.stop(queued.id);
  jobs.stop(run.id);
  await until(() => jobs.get(queued.id)!.state === 'stopped');
  assert.equal(sawAbort, true);
  assert.equal(jobs.get(run.id)!.state, 'stopped');
  assert.equal(jobs.get(run.id)!.result, 'partial', 'what it had is still there');
  assert.equal(started, false);
  assert.equal(jobs.stop('j-nothere'), null);
});

test('closing stops what is running and waits for it', async () => {
  const jobs = new Jobs();
  let ended = false;
  jobs.start({ kind: 'r', caseId: null, label: 'r' }, async ({ signal }) => { await new Promise<void>(r => signal.addEventListener('abort', () => r())); await sleep(30); ended = true; });
  await sleep(30);
  await jobs.close();
  assert.equal(ended, true);
});
