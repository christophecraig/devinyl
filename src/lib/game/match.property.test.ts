/**
 * Property tests — technical-spec §8.2.
 *
 * Three properties carry the "type guesses with typos and still score"
 * acceptance criterion:
 *   1. every accepted form matches itself (no answer is unanswerable);
 *   2. a mutation within the threshold still matches (the forgiveness promise);
 *   3. distinct real titles never cross-match (forgiveness has a limit).
 *
 * Property 3 runs against the real Phase 0 probe list when it is present, so the
 * corpus is actual French repertoire rather than invented strings.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildAnswerKey, damerauLevenshtein, match, maxDistanceFor } from './match.js';
import { normalize } from './normalize.js';

/** Printable text that survives normalization to something non-empty. */
const meaningfulText = fc
	.string({ minLength: 1, maxLength: 40 })
	.filter((s) => normalize(s).length > 0);

describe('property: every accepted form matches itself', () => {
	it('holds for arbitrary text', () => {
		fc.assert(
			fc.property(meaningfulText, (raw) => {
				const key = buildAnswerKey({
					title: raw,
					titleShort: raw,
					artists: [{ name: raw, primary: true }]
				});
				expect(match(raw, key.title)).toBe(true);
				expect(match(raw, key.artist)).toBe(true);
			}),
			{ numRuns: 500 }
		);
	});

	it('holds under case and whitespace noise', () => {
		fc.assert(
			fc.property(meaningfulText, (raw) => {
				const key = buildAnswerKey({
					title: raw,
					titleShort: raw,
					artists: [{ name: raw, primary: true }]
				});
				expect(match(`  ${raw.toUpperCase()}  `, key.title)).toBe(true);
			}),
			{ numRuns: 300 }
		);
	});
});

/** Apply `count` single-character edits to a string. */
function mutate(
	input: string,
	seeds: readonly { index: number; kind: number; letter: string }[]
): string {
	let out = input;
	for (const seed of seeds) {
		if (out.length === 0) break;
		const at = seed.index % out.length;
		switch (seed.kind % 3) {
			case 0: // substitute
				out = out.slice(0, at) + seed.letter + out.slice(at + 1);
				break;
			case 1: // insert
				out = out.slice(0, at) + seed.letter + out.slice(at);
				break;
			default: // delete
				out = out.slice(0, at) + out.slice(at + 1);
		}
	}
	return out;
}

const editSeed = fc.record({
	index: fc.nat({ max: 1000 }),
	kind: fc.nat({ max: 2 }),
	letter: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split(''))
});

describe('property: a mutation within the threshold still matches', () => {
	it('accepts any input whose true distance is within the length-scaled threshold', () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 4, maxLength: 30 }).filter((s) => normalize(s).length >= 4),
				fc.array(editSeed, { minLength: 1, maxLength: 3 }),
				(raw, seeds) => {
					const accepted = normalize(raw);
					const typo = mutate(accepted, seeds);
					const normalizedTypo = normalize(typo);

					// Only assert the property where the mutation genuinely landed
					// within the threshold — random edits can exceed it, and can
					// also collapse to a different normalized form.
					fc.pre(normalizedTypo.length > 0);

					// The threshold scales on the shorter of the two strings, so a
					// short input cannot borrow a longer answer's tolerance (see the
					// Air/Amir regression in match.test.ts).
					const threshold = maxDistanceFor(Math.min(normalizedTypo.length, accepted.length));
					fc.pre(damerauLevenshtein(normalizedTypo, accepted) <= threshold);

					expect(match(typo, [accepted])).toBe(true);
				}
			),
			{ numRuns: 1000 }
		);
	});
});

// ---------------------------------------------------------------------------
// Property 3 — no cross-matching between distinct real titles
// ---------------------------------------------------------------------------

interface ProbeFile {
	trackProbes?: { artist: string; expectedTrack: string }[];
}

function loadProbeCorpus(): { titles: string[]; artists: string[] } {
	try {
		const path = fileURLToPath(new URL('../../../scripts/probes.json', import.meta.url));
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProbeFile;
		const probes = parsed.trackProbes ?? [];
		return {
			titles: [...new Set(probes.map((p) => p.expectedTrack).filter(Boolean))],
			artists: [...new Set(probes.map((p) => p.artist).filter(Boolean))]
		};
	} catch {
		return { titles: [], artists: [] };
	}
}

const corpus = loadProbeCorpus();

describe('property: distinct real titles never cross-match', () => {
	it('has a probe corpus to test against', () => {
		// A soft assertion: if Phase 0 has not landed probes.json yet this suite is
		// vacuous, and that should be visible rather than silently green.
		expect(corpus.titles.length + corpus.artists.length).toBeGreaterThan(0);
	});

	it('never accepts one real title as another', () => {
		const keys = corpus.titles.map((title) => ({
			title,
			forms: buildAnswerKey({ title, titleShort: title, artists: [] }).title
		}));

		const collisions: string[] = [];
		for (const candidate of keys) {
			for (const other of keys) {
				if (candidate.title === other.title) continue;
				// Genuinely identical normalized forms are not a matcher bug — two
				// tracks really can share a title. Only near-misses are.
				const identical = other.forms.some((form) => candidate.forms.includes(form));
				if (identical) continue;
				if (match(candidate.title, other.forms)) {
					collisions.push(`${candidate.title} matched ${other.title}`);
				}
			}
		}

		expect(collisions).toEqual([]);
	});

	it('never accepts one real artist as another', () => {
		const keys = corpus.artists.map((name) => ({
			name,
			forms: buildAnswerKey({ title: name, titleShort: name, artists: [{ name, primary: true }] })
				.artist
		}));

		const collisions: string[] = [];
		for (const candidate of keys) {
			for (const other of keys) {
				if (candidate.name === other.name) continue;
				const identical = other.forms.some((form) => candidate.forms.includes(form));
				if (identical) continue;
				if (match(candidate.name, other.forms)) {
					collisions.push(`${candidate.name} matched ${other.name}`);
				}
			}
		}

		expect(collisions).toEqual([]);
	});
});

describe('property: match never throws', () => {
	it('survives arbitrary input against arbitrary keys', () => {
		fc.assert(
			fc.property(fc.string(), fc.array(fc.string(), { maxLength: 8 }), (input, keys) => {
				expect(() => match(input, keys.map(normalize).filter(Boolean))).not.toThrow();
			}),
			{ numRuns: 500 }
		);
	});
});
