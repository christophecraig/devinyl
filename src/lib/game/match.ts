/**
 * Fuzzy answer matching — technical-spec §8.2 (ANS-2, ANS-4, ANS-5).
 *
 * Exact-first, then Damerau-Levenshtein with a threshold scaled to the length of
 * the *accepted* form. Pure and isomorphic; the client runs it for instant
 * accept/reject (§7.2) and the server re-runs it as the authority (§7.3).
 *
 * The API deliberately returns a boolean and nothing else. Distance, closeness
 * and "you were one letter off" are all answer leakage (ANS-5).
 */

import { normalizeVariants } from './normalize.js';

/** technical-spec §8.2 — max edit distance by normalized length of the accepted form. */
export function maxDistanceFor(length: number): number {
	if (length <= 3) return 0;
	if (length <= 6) return 1;
	if (length <= 10) return 2;
	return 3;
}

/**
 * Optimal String Alignment distance: Levenshtein plus adjacent transpositions at
 * cost 1 ("stromea" → "stromae"), which is the class of typo a player racing a
 * clock actually makes.
 *
 * Bails out as soon as the whole row exceeds `maxDistance`, so a long wrong guess
 * costs almost nothing.
 */
export function damerauLevenshtein(a: string, b: string, maxDistance = Infinity): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let twoRowsBack: number[] = [];
	let previousRow: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	let currentRow: number[] = new Array(b.length + 1);

	for (let i = 1; i <= a.length; i++) {
		currentRow[0] = i;
		let rowMinimum = currentRow[0];

		for (let j = 1; j <= b.length; j++) {
			const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;

			let value = Math.min(
				currentRow[j - 1] + 1, // insertion
				previousRow[j] + 1, // deletion
				previousRow[j - 1] + substitutionCost // substitution
			);

			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				value = Math.min(value, twoRowsBack[j - 2] + 1); // transposition
			}

			currentRow[j] = value;
			if (value < rowMinimum) rowMinimum = value;
		}

		if (rowMinimum > maxDistance) return maxDistance + 1;

		twoRowsBack = previousRow;
		previousRow = currentRow;
		currentRow = new Array(b.length + 1);
	}

	return previousRow[b.length];
}

/**
 * Does `input` match any of `accepted`?
 *
 * `accepted` must already be normalized — these are the forms precomputed at quiz
 * assembly and stored in `track_cache.answers` (§5.4). `input` is raw player text
 * and is normalized here.
 */
export function match(input: string, accepted: readonly string[]): boolean {
	if (!input || accepted.length === 0) return false;

	const inputForms = normalizeVariants(input);
	if (inputForms.length === 0) return false;

	// Exact first — this covers the large majority and costs nothing.
	for (const form of inputForms) {
		for (const candidate of accepted) {
			if (form === candidate) return true;
		}
	}

	for (const candidate of accepted) {
		for (const form of inputForms) {
			// Scale on the *shorter* of the two strings, not on the accepted form
			// alone as technical-spec §8.2 words it. Scaling on the accepted form
			// lets a short input reach a longer answer on a threshold it did not
			// earn: the property test against the real probe corpus caught "Air"
			// (3 chars, threshold 0) matching the artist "Amir" (4 chars,
			// threshold 1) at distance 1. Both are real artists in our catalog, so
			// that is a false accept on a live board, not a hypothetical.
			const threshold = maxDistanceFor(Math.min(form.length, candidate.length));
			if (threshold === 0) continue; // the exact pass above already decided these

			if (damerauLevenshtein(form, candidate, threshold) <= threshold) return true;
		}
	}

	return false;
}

/**
 * Build the accepted-answer forms for a track, run once at assembly time (§5.4).
 *
 * `titleShort` already drops most parenthetical noise on Deezer's side; the full
 * title is included so a player typing the printed title verbatim also matches.
 * Every credited artist is accepted, not just the primary one (ANS-3).
 */
export function buildAnswerKey(track: {
	title: string;
	titleShort?: string | null;
	artists: readonly { name: string; primary?: boolean }[];
}): { title: string[]; artist: string[] } {
	const title = new Set<string>();
	for (const raw of [track.titleShort, track.title]) {
		if (!raw) continue;
		for (const form of normalizeVariants(raw)) title.add(form);
	}

	const artist = new Set<string>();
	for (const credited of track.artists) {
		for (const form of normalizeVariants(credited.name)) artist.add(form);
	}

	return { title: [...title], artist: [...artist] };
}
