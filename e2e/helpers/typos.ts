/**
 * Real, matcher-accepted typos for the happy-path test (plan task 1.30).
 *
 * `src/lib/game/match.ts`'s own module doc gives the exact class of typo the
 * fuzzy matcher is built for: an adjacent-character transposition ("stromea"
 * -> "stromae"), scaled to `maxDistanceFor(length)` — 0 tolerance at length
 * <= 3, 1 at <= 6, 2 at <= 10, 3 above. This module produces that same
 * transposition against real fixture answers and nothing invented.
 */

import { normalize } from '../../src/lib/game/normalize.js';
import { maxDistanceFor } from '../../src/lib/game/match.js';

/**
 * Swaps the last two characters of `raw` — a one-transposition typo a real
 * typist plausibly makes. Returns `null` when the normalized form is too
 * short for the matcher to tolerate any edit at all (`maxDistanceFor === 0`),
 * so callers know to type the exact answer instead.
 */
export function transposedTypo(raw: string): string | null {
	if (maxDistanceFor(normalize(raw).length) === 0) return null;
	if (raw.length < 2) return null;

	const chars = [...raw];
	const last = chars.length - 1;
	[chars[last], chars[last - 1]] = [chars[last - 1], chars[last]];
	return chars.join('');
}
