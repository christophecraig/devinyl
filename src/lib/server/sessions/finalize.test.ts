/**
 * Unit tests for finalize.ts's **pure** decision logic — technical-spec §7.3,
 * plan task 1.16.
 *
 * `finalizeSession` itself is D1-shaped and covered by the integration suite
 * (task 1.19, another agent's file). What's testable here without a database
 * is exactly the logic worth getting right in isolation: how the identity
 * blocks (FAIR-1/2/7) combine, and that they take precedence over whatever
 * `revalidate.ts`'s engine decided — the contract `revalidate.ts` itself
 * states but does not enforce, because enforcing it is the caller's job.
 */

import { describe, expect, it } from 'vitest';
import {
	applyIdentityPrecedence,
	isCreatorOfQuiz,
	resolveIdentityBlock,
	weeklyContribution,
	type IdentityBlockInput
} from './finalize.js';
import type { Player } from '../identity.js';

const clean: IdentityBlockInput = {
	isCreator: false,
	hasPriorScoredRun: false,
	guestDailyReplay: false
};

describe('resolveIdentityBlock (FAIR-1/2/7)', () => {
	it('returns null when nothing blocks the run', () => {
		expect(resolveIdentityBlock(clean)).toBeNull();
	});

	it('blocks with "creator" for the quiz owner (FAIR-1)', () => {
		expect(resolveIdentityBlock({ ...clean, isCreator: true })).toBe('creator');
	});

	it('blocks with "replay" for a prior scored run (FAIR-2)', () => {
		expect(resolveIdentityBlock({ ...clean, hasPriorScoredRun: true })).toBe('replay');
	});

	it('blocks with "replay" for a guest-daily dedupe hit (FAIR-7)', () => {
		expect(resolveIdentityBlock({ ...clean, guestDailyReplay: true })).toBe('replay');
	});

	it('prefers "creator" over "replay" when both apply — it is the more informative reason', () => {
		expect(
			resolveIdentityBlock({ isCreator: true, hasPriorScoredRun: true, guestDailyReplay: false })
		).toBe('creator');
	});
});

describe('applyIdentityPrecedence (§7.3 step 4/5 combined)', () => {
	it('scores when neither identity nor the engine blocks', () => {
		expect(applyIdentityPrecedence(null, null)).toEqual({ scored: true, blockReason: null });
	});

	it('falls through to the engine reason when identity has none', () => {
		expect(applyIdentityPrecedence(null, 'implausible')).toEqual({
			scored: false,
			blockReason: 'implausible'
		});
	});

	it('an identity block wins even when the engine tier is clean — the core precedence rule', () => {
		expect(applyIdentityPrecedence('creator', null)).toEqual({
			scored: false,
			blockReason: 'creator'
		});
	});

	it('an identity block wins over a *different* engine block too', () => {
		// A replay that also happens to look implausible is still reported as a
		// replay — the identity fact is what actually disqualifies it.
		expect(applyIdentityPrecedence('replay', 'implausible')).toEqual({
			scored: false,
			blockReason: 'replay'
		});
	});
});

describe('isCreatorOfQuiz (FAIR-1)', () => {
	const user: Player = { kind: 'user', userId: 'u1', guestId: null };
	const guest: Player = { kind: 'guest', userId: null, guestId: 'g1' };

	it('is never true for a guest — guests cannot own quizzes', () => {
		expect(isCreatorOfQuiz(guest, { ownerId: null, kind: 'manual' }, false)).toBe(false);
	});

	it('is true for the quiz owner', () => {
		expect(isCreatorOfQuiz(user, { ownerId: 'u1', kind: 'manual' }, false)).toBe(true);
	});

	it('is false for a non-owner on a non-official quiz, even for an operator', () => {
		expect(isCreatorOfQuiz(user, { ownerId: 'someone-else', kind: 'manual' }, true)).toBe(false);
	});

	it('is true for an operator on an official quiz they do not own', () => {
		expect(isCreatorOfQuiz(user, { ownerId: null, kind: 'official' }, true)).toBe(true);
	});

	it('is true for an operator on a daily quiz', () => {
		expect(isCreatorOfQuiz(user, { ownerId: null, kind: 'daily' }, true)).toBe(true);
	});

	it('is false for a non-operator on an official quiz', () => {
		expect(isCreatorOfQuiz(user, { ownerId: null, kind: 'official' }, false)).toBe(false);
	});
});

describe('weeklyContribution (STAT-4, §11)', () => {
	it('normalizes to a 100-point scale', () => {
		expect(weeklyContribution(500, 1000, false)).toBe(50);
	});

	it('weights the daily ×2', () => {
		expect(weeklyContribution(500, 1000, true)).toBe(100);
	});

	it('rounds rather than truncating', () => {
		// 2/3 * 100 = 66.67 -> 67
		expect(weeklyContribution(2, 3, false)).toBe(67);
	});

	it('is zero for a perfect-zero max (defensive — should not happen for a scored session)', () => {
		expect(weeklyContribution(0, 0, false)).toBe(0);
	});

	it('is zero for a zero score', () => {
		expect(weeklyContribution(0, 1000, true)).toBe(0);
	});
});
