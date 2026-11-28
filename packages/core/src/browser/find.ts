import { findBrowser as find } from '@haithamexe/plainkit/browser';

/**
 * A Chromium-based browser that is already on the machine (Chrome, Edge, Brave, Chromium). Assay installs nothing and downloads nothing.
 * The person can point at one with `assay allow-run --browser <path>` or ASSAY_BROWSER (CHROME_PATH works too).
 */
export function findBrowser(custom?: string): string | null {
  return find({ custom, env: ['ASSAY_BROWSER', 'CHROME_PATH'] })?.path ?? null;
}
