/**
 * A signed-in session for checks that go through a running app (attack, gremlins). It comes only from the environment of the process:
 * a command-line argument shows in the process list and a shell history, and an MCP argument would put the person's session in a
 * model's context. ASSAY_SESSION_COOKIE and ASSAY_SESSION_AUTHORIZATION (the older ASSAY_ATTACK_* names still work).
 */
export interface Session { cookie?: string; authorization?: string }

export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): Session | undefined {
  const cookie = env.ASSAY_SESSION_COOKIE || env.ASSAY_ATTACK_COOKIE || undefined;
  const authorization = env.ASSAY_SESSION_AUTHORIZATION || env.ASSAY_ATTACK_AUTHORIZATION || undefined;
  return cookie || authorization ? { cookie, authorization } : undefined;
}

/** Every value of a session, for taking it out of text that may echo it. */
export function sessionValues(s: Session | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.authorization) out.push(s.authorization, s.authorization.replace(/^\w+\s+/, ''));
  if (s.cookie) { out.push(s.cookie); for (const part of s.cookie.split(';')) { const v = part.slice(part.indexOf('=') + 1).trim(); if (v) out.push(v); } }
  return [...new Set(out.filter(v => v.length >= 4))].sort((a, b) => b.length - a.length);
}
