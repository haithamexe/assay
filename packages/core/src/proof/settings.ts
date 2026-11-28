import fs from 'node:fs';
import { assayPath, writeFileAtomic } from '../config.js';
import { repoKey } from '../git.js';

/**
 * Running the project's code is opt-in per repository (D14). The person turns it on from the terminal (`assay allow-run`);
 * the MCP server can read this and never write it, so an agent can't give itself permission.
 */
export interface RepoSettings {
  allow?: boolean;
  /** A test command the person chose, run through a shell exactly as typed. Without one, the command is found from the project's manifest. */
  command?: string;
  /** Seconds one test run may take. */
  timeout?: number;
  /** The command that starts the project's dev server for the browser checks. {port} is replaced; PORT is also set. Without one, plain HTML files are served as they are. */
  serve?: string;
  /** Paths to look at, e.g. ["/", "/cart"]. Without any: the HTML files the range changed, or / for a dev server. */
  pages?: string[];
  /** A Chromium-based browser, if Assay can't find one. */
  browser?: string;
  /** Tokens the reviewer panel may cost for a case (0 = free checks only). Harmless, so the dashboard may set it; it never runs anything. */
  budget?: number;
  /** `assay test --here` may run the tests in the repository's own folder, uncommitted work included (D61). Terminal only, like `allow`. */
  here?: boolean;
  /** `assay attack --writes` may send requests that change data: saved text, wrong passwords, a request as another site would send it (D64). Terminal only, like `allow`. */
  writes?: boolean;
  /** `assay try` may let the package manager reach its registry: it installs a package version in a throwaway copy (D67). Terminal only, like `allow`. */
  network?: boolean;
}

export const DEFAULT_BUDGET = 40_000;
/** The budget for this repository's reviewers: the person's choice, else a modest default. */
export const reviewBudget = (repo: string): number => {
  const b = repoSettings(repo).budget;
  return typeof b === 'number' && Number.isFinite(b) && b >= 0 ? Math.min(Math.round(b), 400_000) : DEFAULT_BUDGET;
};

const file = (): string => assayPath('repos.json');

function readAll(): Record<string, RepoSettings> {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, RepoSettings>; } catch { return {}; }
}

export function repoSettings(repo: string): RepoSettings {
  return readAll()[repoKey(repo)] ?? {};
}

export function setRepoSettings(repo: string, patch: RepoSettings): RepoSettings {
  const all = readAll();
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as RepoSettings;
  const next = { ...(all[repoKey(repo)] ?? {}), ...given };
  all[repoKey(repo)] = next;
  writeFileAtomic(file(), JSON.stringify(all, null, 1));
  return next;
}

export const isAllowed = (repo: string): boolean => repoSettings(repo).allow === true;
