/**
 * `seededShuffle` — ANS-6's per-session shuffle stability.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { seededShuffle } from './shuffle.js';

describe('seededShuffle: deterministic for the same seed', () => {
	it('returns the same order across repeated calls with identical key parts', () => {
		const items = ['a', 'b', 'c', 'd'];
		const first = seededShuffle(items, 'session-1', 3, 'title');
		const second = seededShuffle(items, 'session-1', 3, 'title');
		expect(second).toEqual(first);
	});

	it('does not mutate the input array', () => {
		const items = ['a', 'b', 'c', 'd'];
		const copy = [...items];
		seededShuffle(items, 'session-1', 3, 'title');
		expect(items).toEqual(copy);
	});
});

describe('seededShuffle: differs for different seeds', () => {
	it('produces a different order for a different sessionId', () => {
		const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		const a = seededShuffle(items, 'session-1', 0, 'title');
		const b = seededShuffle(items, 'session-2', 0, 'title');
		expect(b).not.toEqual(a);
	});

	it('produces a different order for a different position', () => {
		const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		const a = seededShuffle(items, 'session-1', 0, 'title');
		const b = seededShuffle(items, 'session-1', 1, 'title');
		expect(b).not.toEqual(a);
	});

	it('produces a different order for a different target', () => {
		const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		const a = seededShuffle(items, 'session-1', 0, 'title');
		const b = seededShuffle(items, 'session-1', 0, 'artist');
		expect(b).not.toEqual(a);
	});
});

describe('property: seededShuffle is a true permutation', () => {
	it('returns the same multiset of elements it was given, for arbitrary keys', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer(), { minLength: 0, maxLength: 20 }),
				fc.string(),
				fc.integer(),
				fc.string(),
				(items, sessionId, position, target) => {
					const shuffled = seededShuffle(items, sessionId, position, target);
					expect(shuffled).toHaveLength(items.length);
					expect([...shuffled].sort()).toEqual([...items].sort());
				}
			),
			{ numRuns: 500 }
		);
	});

	it('holds for the concrete 4-option case components will actually use', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 4, maxLength: 4 }),
				fc.string({ minLength: 1 }),
				fc.nat(),
				fc.constantFrom('title', 'artist'),
				(items, sessionId, position, target) => {
					const shuffled = seededShuffle(items, sessionId, position, target);
					expect([...shuffled].sort()).toEqual([...items].sort());
				}
			),
			{ numRuns: 500 }
		);
	});
});
