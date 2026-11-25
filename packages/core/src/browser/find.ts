import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A Chromium-based browser that is already on the machine (Chrome, Edge, Brave, Chromium). Assay installs nothing and downloads nothing.
 * The person can point at one with `assay allow-run --browser <path>` or ASSAY_BROWSER.
 */
export function findBrowser(custom?: string): string | null {
  for (const c of [custom, process.env.ASSAY_BROWSER]) if (c && fs.existsSync(c)) return c;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const k of ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']) {
      const base = process.env[k];
      if (!base) continue;
      candidates.push(
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(base, 'Chromium', 'Application', 'chrome.exe')
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) candidates.push(path.join(os.homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
  } else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) candidates.push(path.join(dir, n));
    }
    // where the packages put them when the PATH doesn't (a snap, a vendor folder)
    candidates.push('/snap/bin/chromium', '/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge', '/opt/brave.com/brave/brave-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}
