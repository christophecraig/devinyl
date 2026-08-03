import { describe, expect, it } from 'vitest';
import {
	revalidateSession,
	type RevalidateInput,
	type RevalidateRoundInput
} from './revalidate.js';
import type { GuessLog } from '$lib/game/types.js';

const CLIP = 30_000;
const START = 1_700_000_000_000;

const answers = { title: ['alors on danse'], artist: ['stromae'] };

function guesses(...entries: [target: 'title' | 'artist', raw: string, atMs: number][]): GuessLog {
	return entries.map(([target, raw, atMs]) => ({ target, raw, atMs }));
}

function round(overrides: Partial<RevalidateRoundInput> = {}): RevalidateRoundInput {
	return {
		position: 0,
		guessLog: [],
		lockTimes: {},
		clipMs: CLIP,
		skipped: false,
		answers,
		knownPreviewMs: CLIP,
		serverReceivedAt: START + CLIP,
		...overrides
	};
}

function input(overrides: Partial<RevalidateInput> = {}): RevalidateInput {
	const rounds = overrides.rounds ?? [round()];
	// Derive the wall clock from the rounds' real durations so a fixture cannot
	// accidentally trip the wall-clock invariant and mask the branch under test.
	const claimedTotal = rounds.filter((r) => !r.skipped).reduce((sum, r) => sum + r.clipMs, 0);
	return {
		rounds,
		guessTarget: 'both',
		scoringMode: 'speed',
		curveVersion: 1,
		serverRoundLog: rounds.map((r) => ({ position: r.position, at: START + r.position * CLIP })),
		startedAt: START,
		finalizedAt: START + claimedTotal + 5_000,
		...overrides
	};
}

describe('§7.3 step 1 — correctness comes from the raw log, never the client', () => {
	it('scores a correct guess found in the guess log', () => {
		const result = revalidateSession(
			input({ rounds: [round({ guessLog: guesses(['title', 'Alors on danse', 0]) })] })
		);
		expect(result.rounds[0].titleOk).toBe(true);
		expect(result.totalScore).toBe(1000);
	});

	it('ignores a claimed lock the log does not support', () => {
		// The client says it locked the title at 0 ms, but never submitted anything.
		const result = revalidateSession(
			input({ rounds: [round({ guessLog: [], lockTimes: { title: 0 } })] })
		);
		expect(result.rounds[0].titleOk).toBe(false);
		expect(result.totalScore).toBe(0);
		expect(result.notes.join()).toMatch(/could not reproduce/);
	});

	it('ignores a claimed lock whose guess was actually wrong', () => {
		const result = revalidateSession(
			input({
				rounds: [
					round({ guessLog: guesses(['title', 'papaoutai', 500]), lockTimes: { title: 500 } })
				]
			})
		);
		expect(result.rounds[0].titleOk).toBe(false);
		expect(result.totalScore).toBe(0);
	});

	it('takes the earliest matching attempt as the lock time', () => {
		const result = revalidateSession(
			input({
				rounds: [
					round({
						guessLog: guesses(
							['title', 'wrong', 1_000],
							['title', 'alors on danse', 3_000],
							['title', 'alors on danse', 9_000]
						)
					})
				]
			})
		);
		expect(result.rounds[0].titleMs).toBe(3_000);
	});

	it('applies the forgiving matcher, so a typo still scores (ANS-2)', () => {
		const result = revalidateSession(
			input({ rounds: [round({ guessLog: guesses(['title', 'alors on dance', 0]) })] })
		);
		expect(result.rounds[0].titleOk).toBe(true);
	});

	it('scores each target independently (SCORE-1)', () => {
		const result = revalidateSession(
			input({
				rounds: [
					round({ guessLog: guesses(['title', 'alors on danse', 0], ['artist', 'nope', 0]) })
				]
			})
		);
		expect(result.rounds[0].titleOk).toBe(true);
		expect(result.rounds[0].artistOk).toBe(false);
		expect(result.totalScore).toBe(1000);
	});
});

describe('guess targets the quiz does not use are not scored (QUIZ-3)', () => {
	it('leaves artist null on a title-only quiz', () => {
		const result = revalidateSession(
			input({
				guessTarget: 'title',
				rounds: [
					round({ guessLog: guesses(['title', 'alors on danse', 0], ['artist', 'stromae', 0]) })
				]
			})
		);
		expect(result.rounds[0].artistOk).toBeNull();
		expect(result.totalScore).toBe(1000);
		expect(result.maxPossibleScore).toBe(1000);
	});

	it('leaves title null on an artist-only quiz', () => {
		const result = revalidateSession(
			input({
				guessTarget: 'artist',
				rounds: [round({ guessLog: guesses(['artist', 'stromae', 0]) })]
			})
		);
		expect(result.rounds[0].titleOk).toBeNull();
		expect(result.totalScore).toBe(1000);
	});
});

describe('§7.3 step 4 — a skipped round unscores the session (MUS-5, FAIR-6)', () => {
	it('blocks with clip_unavailable and still reports a score', () => {
		const result = revalidateSession(
			input({
				rounds: [
					round({ position: 0, guessLog: guesses(['title', 'alors on danse', 0]) }),
					round({ position: 1, skipped: true })
				]
			})
		);
		expect(result.blockReason).toBe('clip_unavailable');
		expect(result.totalScore).toBe(1000); // the player still sees what they earned
		expect(result.rounds[1].points).toBe(0);
		expect(result.rounds[1].skipped).toBe(true);
	});

	it('excludes the skipped round from the maximum, so it is no penalty', () => {
		const result = revalidateSession(
			input({ rounds: [round({ position: 0 }), round({ position: 1, skipped: true })] })
		);
		expect(result.maxPossibleScore).toBe(2000); // one playable round × 2 targets
	});
});

describe('§7.3 step 3 — clipMs cannot be inflated to buy a gentler curve', () => {
	it('rejects a clipMs well beyond the known preview duration', () => {
		const result = revalidateSession(
			input({ rounds: [round({ clipMs: 120_000, knownPreviewMs: CLIP })] })
		);
		expect(result.blockReason).toBe('implausible');
		expect(result.notes.join()).toMatch(/clipMs 120000 vs known 30000/);
	});

	it('allows small drift within tolerance', () => {
		const result = revalidateSession(
			input({ rounds: [round({ clipMs: CLIP + 1_500, knownPreviewMs: CLIP })] })
		);
		expect(result.blockReason).toBeNull();
	});

	it('skips the check when the server has no known duration', () => {
		const result = revalidateSession(
			input({ rounds: [round({ clipMs: 45_000, knownPreviewMs: null })] })
		);
		expect(result.blockReason).toBeNull();
	});
});

describe('§7.3 step 3 — reconstructed invariants', () => {
	it('rejects non-monotonic guess timestamps', () => {
		const result = revalidateSession(
			input({
				rounds: [round({ guessLog: guesses(['title', 'a', 5_000], ['title', 'b', 1_000]) })]
			})
		);
		expect(result.blockReason).toBe('implausible');
		expect(result.notes.join()).toMatch(/not monotonic/);
	});

	it('rejects an attempt outside the clip window', () => {
		const result = revalidateSession(
			input({ rounds: [round({ guessLog: guesses(['title', 'alors on danse', 90_000]) })] })
		);
		expect(result.blockReason).toBe('implausible');
	});

	it('rejects a negative lock time', () => {
		const result = revalidateSession(input({ rounds: [round({ lockTimes: { title: -5 } })] }));
		expect(result.blockReason).toBe('implausible');
	});

	it('rejects rounds arriving out of order', () => {
		const result = revalidateSession(
			input({ rounds: [round({ position: 3 }), round({ position: 1 })] })
		);
		expect(result.blockReason).toBe('implausible');
		expect(result.notes.join()).toMatch(/out of order/);
	});

	it('rejects a session that took less wall-clock time than the clips it claims', () => {
		const result = revalidateSession(
			input({
				rounds: [round({ position: 0 }), round({ position: 1 })],
				startedAt: START,
				finalizedAt: START + 5_000 // two 30 s clips cannot fit in 5 s
			})
		);
		expect(result.blockReason).toBe('implausible');
		expect(result.notes.join()).toMatch(/wall clock/);
	});
});

describe('§7.3 step 3 — the two tiers', () => {
	it('reports "verified" when a beacon bounds every round', () => {
		const result = revalidateSession(input());
		expect(result.tier).toBe('verified');
		expect(result.blockReason).toBeNull();
	});

	it('falls back to "reconstructed" when beacons are missing — an offline run still scores', () => {
		// MUS-7 promises play survives a connection drop, and a drop means the
		// beacons never arrived. Punishing that would make the guarantee a trap.
		const result = revalidateSession(input({ serverRoundLog: [] }));
		expect(result.tier).toBe('reconstructed');
		expect(result.blockReason).toBeNull();
	});

	it('does not disqualify on a verified-tier failure alone (§7.3 step 4)', () => {
		// Beacon says the round started far later than the claimed elapsed allows —
		// a late-flushed beacon looks exactly like this.
		const result = revalidateSession(
			input({
				rounds: [
					round({
						guessLog: guesses(['title', 'alors on danse', 25_000]),
						// The result POST reached the server only 3 s after the beacon,
						// which cannot bracket a claimed 25 s of clip time.
						serverReceivedAt: START + 3_000
					})
				],
				serverRoundLog: [{ position: 0, at: START }],
				// Wall clock is generous, so only the verified tier fails here.
				finalizedAt: START + 40_000
			})
		);
		expect(result.notes.join()).toMatch(/verified-tier/);
		// Invariants still hold, so it scores.
		expect(result.blockReason).not.toBe('implausible');
	});

	it('reports unverified_timing when there is no evidence at all', () => {
		const result = revalidateSession(
			input({
				rounds: [round({ serverReceivedAt: null })],
				serverRoundLog: []
			})
		);
		expect(result.tier).toBe('none');
		expect(result.blockReason).toBe('unverified_timing');
	});

	it('treats a partially-beaconed run as reconstructed, not verified', () => {
		const result = revalidateSession(
			input({
				rounds: [round({ position: 0 }), round({ position: 1 })],
				serverRoundLog: [{ position: 0, at: START }]
			})
		);
		expect(result.tier).toBe('reconstructed');
	});
});

describe('scoring modes and the curve', () => {
	it('uses fixed scoring when the session resolved to fixed (A11Y-5)', () => {
		const result = revalidateSession(
			input({
				scoringMode: 'fixed',
				rounds: [round({ guessLog: guesses(['title', 'alors on danse', 29_000]) })]
			})
		);
		// Fixed pays a constant regardless of how late the answer came.
		expect(result.totalScore).toBe(500);
		expect(result.maxPossibleScore).toBe(1000);
	});

	it('rewards speed under speed scoring', () => {
		const fast = revalidateSession(
			input({ rounds: [round({ guessLog: guesses(['title', 'alors on danse', 0]) })] })
		);
		const slow = revalidateSession(
			input({ rounds: [round({ guessLog: guesses(['title', 'alors on danse', 29_000]) })] })
		);
		expect(fast.totalScore).toBeGreaterThan(slow.totalScore);
	});

	it('refuses an unknown curve version rather than guessing', () => {
		expect(() => revalidateSession(input({ curveVersion: 99 }))).toThrow(/curve_version/i);
	});
});

describe('a clean full session', () => {
	it('scores ten rounds and posts', () => {
		const rounds = Array.from({ length: 10 }, (_, i) =>
			round({
				position: i,
				guessLog: guesses(['title', 'alors on danse', 2_000], ['artist', 'stromae', 4_000]),
				serverReceivedAt: START + (i + 1) * CLIP
			})
		);
		const result = revalidateSession(input({ rounds }));

		expect(result.blockReason).toBeNull();
		expect(result.tier).toBe('verified');
		expect(result.rounds).toHaveLength(10);
		expect(result.maxPossibleScore).toBe(20_000);
		expect(result.totalScore).toBe(10 * (940 + 880));
	});
});
