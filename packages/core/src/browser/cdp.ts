import crypto from 'node:crypto';
import { Browser as KitBrowser, Page } from '@haithamexe/plainkit/browser';
import { CdpPipe } from '@haithamexe/plainkit/cdp';
import { assayPath } from '../config.js';

/**
 * Assay's DevTools client over the browser's own pipe (--remote-debugging-pipe): no port is opened, nothing is installed,
 * and no automation library is involved. The client lives in plainkit, a zero-dependency kit shared with Assay's sister
 * tools (D58); this file only gives it Assay's profile folder.
 */
export { CdpPipe as Cdp, Page };
export type { PageEvents } from '@haithamexe/plainkit/browser';

export type Browser = KitBrowser;
export const Browser = {
  /** A headless browser with a throwaway profile under ~/.assay/work, removed when it closes. */
  launch(exe: string): Promise<KitBrowser> {
    return KitBrowser.launch(exe, { profileDir: assayPath('work', `browser-${crypto.randomBytes(4).toString('hex')}`) });
  }
};
