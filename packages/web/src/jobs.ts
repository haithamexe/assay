import crypto from 'node:crypto';

/**
 * Anything that runs the project's code (tests, a browser) or takes a while is a job: it is queued, runs one at a time,
 * says what it is doing as it goes, and can be stopped. The page polls it, so no connection is held open.
 */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface JobView {
  id: string;
  kind: string;
  caseId: string | null;
  label: string;
  state: JobState;
  messages: string[];
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  result?: unknown;
  error?: string;
}

interface Job extends JobView { ctl: AbortController }

export interface JobContext { say: (message: string) => void; signal: AbortSignal }

const KEEP = 30;
const MAX_MESSAGES = 200;

export class Jobs {
  private all = new Map<string, Job>();
  private chain: Promise<void> = Promise.resolve();

  start(spec: { kind: string; caseId: string | null; label: string }, fn: (ctx: JobContext) => Promise<unknown>): JobView {
    const job: Job = { id: `j-${crypto.randomBytes(5).toString('hex')}`, ...spec, state: 'queued', messages: [], queuedAt: Date.now(), startedAt: null, endedAt: null, ctl: new AbortController() };
    this.all.set(job.id, job);
    for (const old of [...this.all.keys()].slice(0, Math.max(0, this.all.size - KEEP))) {
      const j = this.all.get(old);
      if (j && (j.state === 'done' || j.state === 'failed' || j.state === 'stopped')) this.all.delete(old);
    }
    this.chain = this.chain.then(async () => {
      if (job.ctl.signal.aborted) { job.state = 'stopped'; job.endedAt = Date.now(); return; }
      job.state = 'running';
      job.startedAt = Date.now();
      try {
        job.result = await fn({
          say: m => { job.messages.push(String(m).slice(0, 300)); if (job.messages.length > MAX_MESSAGES) job.messages.shift(); },
          signal: job.ctl.signal
        });
        job.state = job.ctl.signal.aborted ? 'stopped' : 'done';
      } catch (err) {
        job.state = job.ctl.signal.aborted ? 'stopped' : 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }
      job.endedAt = Date.now();
    });
    return this.view(job);
  }

  private view(j: Job): JobView {
    const { ctl: _ctl, ...v } = j;
    return { ...v, messages: [...v.messages] };
  }

  get(id: string): JobView | null {
    const j = this.all.get(id);
    return j ? this.view(j) : null;
  }

  /** Stop a job: a queued one never starts, a running one is told to stop (a test run's whole process tree is killed). */
  stop(id: string): JobView | null {
    const j = this.all.get(id);
    if (!j) return null;
    if (j.state === 'queued' || j.state === 'running') j.ctl.abort();
    return this.view(j);
  }

  /** The job in progress, or the next one waiting. */
  active(): JobView | null {
    for (const j of this.all.values()) if (j.state === 'running') return this.view(j);
    for (const j of this.all.values()) if (j.state === 'queued') return this.view(j);
    return null;
  }

  busyCase(caseId: string): boolean {
    for (const j of this.all.values()) if (j.caseId === caseId && (j.state === 'queued' || j.state === 'running')) return true;
    return false;
  }

  /** On shutdown: stop everything and wait for it to let go of its files. */
  async close(): Promise<void> {
    for (const j of this.all.values()) if (j.state === 'queued' || j.state === 'running') j.ctl.abort();
    await this.chain.catch(() => undefined);
  }
}
