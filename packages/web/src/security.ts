import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The dashboard answers one person on one computer. Three things make that true (docs/PROJECT.md D24):
 * it listens on 127.0.0.1 only; every request needs the token this run made (sent once in the address, then kept in a cookie
 * the page's own script can't read); and a page's script can't run anything but this server's own files.
 */
export const COOKIE = 'assay_session';

/** Nothing loads from anywhere but this server, and no inline script or style runs, so a mistake in escaping can't become script. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

export const newToken = (): string => crypto.randomBytes(24).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The Host header must name this server on the loopback address. Anything else is a web page on the internet whose name was pointed at 127.0.0.1 (DNS rebinding). */
export function hostOk(req: IncomingMessage, port: number): boolean {
  const h = (req.headers.host ?? '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** A browser always says where a request came from when it posts. Without it, or from anywhere else, the request is refused. */
export function originOk(req: IncomingMessage, port: number): boolean {
  const o = req.headers.origin;
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

export function cookieOf(req: IncomingMessage, name = COOKIE): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
