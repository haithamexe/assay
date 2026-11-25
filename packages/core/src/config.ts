import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Everything Assay keeps lives here: ~/.assay, or ASSAY_HOME (tests and demos set it). */
export function assayHome(): string {
  return process.env.ASSAY_HOME || path.join(os.homedir(), '.assay');
}
export function assayPath(...parts: string[]): string {
  return path.join(assayHome(), ...parts);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Written whole: a temp file, then a rename (retried a few times, since Windows can refuse a rename for a moment). Mode 0600. */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i < 6 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(20 * (i + 1));
        continue;
      }
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
  }
}

/** A tool answer is capped, and says how to get the rest. */
export function cap(text: string, max = 6000, more = 'Ask for one finding to see the rest.'): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (${text.length - max} more characters. ${more})`;
}

export const sha = (s: string, n = 8): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
