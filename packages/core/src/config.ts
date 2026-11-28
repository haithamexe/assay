import crypto from 'node:crypto';
import path from 'node:path';
import { toolHome, writeFileAtomic as kitWriteFileAtomic } from '@haithamexe/plainkit/fs';

/** Everything Assay keeps lives here: ~/.assay, or ASSAY_HOME (tests and demos set it). */
export function assayHome(): string {
  return toolHome('ASSAY_HOME', '.assay');
}
export function assayPath(...parts: string[]): string {
  return path.join(assayHome(), ...parts);
}

/** Written whole: a temp file, then a rename (retried a few times, since Windows can refuse a rename for a moment). Mode 0600. */
export function writeFileAtomic(file: string, data: string): void {
  kitWriteFileAtomic(file, data, { mode: 0o600, mkdir: true });
}

/** A tool answer is capped, and says how to get the rest. */
export function cap(text: string, max = 6000, more = 'Ask for one finding to see the rest.'): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (${text.length - max} more characters. ${more})`;
}

export const sha = (s: string, n = 8): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
