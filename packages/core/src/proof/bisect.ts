/**
 * Which commit broke it (D49). A range was known to go from passing (its base) to failing (its head); this narrows it to two neighbours
 * by running the tests in the middle of what is left, then in the half that still holds the change. For a range of n commits that is at
 * most ceil(log2 n) runs, and every run is cached by commit, so asking again costs nothing.
 *
 * The search is only about the order of commits, so it knows nothing about tests: the caller says what a commit's result was.
 * A line that goes bad, good, bad again has more than one place where it changes; this finds one of them, and the claim it makes
 * ("passed at the one before, fails here") is true of that place because both ends were run.
 */
export type Judged = 'good' | 'bad' | 'unclear' | 'stop';

export interface Search {
  /** The newest commit known to pass, as an index into the chain (-1 is the base). */
  lo: number;
  /** The oldest commit known to fail (the head is the last index). */
  hi: number;
  /** True when lo and hi are neighbours: hi is the first commit where it fails. */
  found: boolean;
  /** How many commits were judged. */
  tried: number;
  /** Why it stopped short: a result that could not be judged (a timeout, a build that never started), or a stop (the time budget, or a person). */
  stopped?: 'unclear' | 'stop';
}

/** `chain` is the commits after the base, oldest first, ending in the head. The base is known to pass and the head is known to fail. */
export async function searchFirstBad(chain: string[], judge: (commit: string) => Promise<Judged>): Promise<Search> {
  let lo = -1;
  let hi = chain.length - 1;
  let tried = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const v = await judge(chain[mid]);
    tried++;
    if (v === 'bad') hi = mid;
    else if (v === 'good') lo = mid;
    else return { lo, hi, found: false, tried, stopped: v };
  }
  return { lo, hi, found: true, tried };
}
