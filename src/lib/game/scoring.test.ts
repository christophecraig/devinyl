import { describe, expect, it } from 'vitest';
import {
	CURRENT_CURVE_VERSION,
	getCurve,
	maxPossibleScore,
	scoreRound,
	scoreSession,
	weeklyPoints,
	type RoundScoreInput
} from './scoring.js';

const CLIP = 30_000;
const correct = (lockMs: number) => ({ correct: true, lockMs });
const missed = { correct: false, lockMs: null };

describe('curve v1 — speed mode (SCORE-2)', () => {
	const curve = getCurve(1);

	it.each([
		[0, 1000],
		[CLIP, 100],
		[CLIP / 2, 550],
		[CLIP * 0.1, 910]
	])('t=%i ms → %i points', (lockMs, expected) => {
		expect(curve.points('speed', lockMs, CLIP)).toBe(expected);
	});

	it('clamps at the floor rather than going below it', () => {
		expect(curve.points('speed', CLIP * 2, CLIP)).toBe(100);
		expect(curve.points('speed', Number.MAX_SAFE_INTEGER, CLIP)).toBe(100);
	});

	it('is monotonically non-increasing across the clip', () => {
		let previous = Infinity;
		for (let t = 0; t <= CLIP; t += 250) {
			const points = curve.points('speed', t, CLIP);
			expect(points).toBeLessThanOrEqual(previous);
			previous = points;
		}
	});

	it('scales to the measured clip duration, not a hardcoded 30 s (§9)', () => {
		// Half-way through a short clip must earn the same as half-way through a
		// long one — otherwise a short preview gets a steeper curve than its
		// neighbours purely by accident of encoding.
		expect(curve.points('speed', 5_000, 10_000)).toBe(curve.points('speed', 15_000, 30_000));
	});

	it('awards the floor rather than dividing by zero on an unknown clip length', () => {
		expect(curve.points('speed', 1_000, 0)).toBe(100);
		expect(curve.points('speed', 1_000, Number.NaN)).toBe(100);
	});

	it('never returns negative points (SCORE-4)', () => {
		expect(curve.points('speed', -1, CLIP)).toBe(0);
	});
});

describe('curve v1 — fixed mode (SCORE-3)', () => {
	const curve = getCurve(1);

	it('pays a constant regardless of speed', () => {
		expect(curve.points('fixed', 0, CLIP)).toBe(500);
		expect(curve.points('fixed', CLIP, CLIP)).toBe(500);
		expect(curve.points('fixed', CLIP * 10, CLIP)).toBe(500);
	});
});

describe('the curve registry is frozen (SCORE-6)', () => {
	it('exposes v1 as the current version', () => {
		expect(CURRENT_CURVE_VERSION).toBe(1);
		expect(getCurve(CURRENT_CURVE_VERSION).version).toBe(1);
	});

	it('refuses an unknown version rather than silently guessing', () => {
		expect(() => getCurve(99)).toThrow(/curve_version/i);
	});

	it('pins v1 boundary values so a future edit to v1 fails loudly', () => {
		const curve = getCurve(1);
		expect(curve.points('speed', 0, 30_000)).toBe(1000);
		expect(curve.points('speed', 30_000, 30_000)).toBe(100);
		expect(curve.points('fixed', 0, 30_000)).toBe(500);
	});
});

describe('scoreRound — SCORE-1', () => {
	it('sums both targets', () => {
		const round: RoundScoreInput = { title: correct(0), artist: correct(CLIP), clipMs: CLIP };
		expect(scoreRound(round, 'speed')).toBe(1100);
	});

	it('scores each target independently — one right, one wrong', () => {
		const round: RoundScoreInput = { title: correct(0), artist: missed, clipMs: CLIP };
		expect(scoreRound(round, 'speed')).toBe(1000);
	});

	it('gives an unanswered round zero (SCORE-4)', () => {
		expect(scoreRound({ title: missed, artist: missed, clipMs: CLIP }, 'speed')).toBe(0);
		expect(scoreRound({ clipMs: CLIP }, 'speed')).toBe(0);
	});

	it('gives a target marked correct but never locked zero', () => {
		const round: RoundScoreInput = { title: { correct: true, lockMs: null }, clipMs: CLIP };
		expect(scoreRound(round, 'speed')).toBe(0);
	});

	it('excludes a skipped round entirely, with no penalty (MUS-5)', () => {
		const round: RoundScoreInput = {
			title: correct(0),
			artist: correct(0),
			clipMs: CLIP,
			skipped: true
		};
		expect(scoreRound(round, 'speed')).toBe(0);
	});
});

describe('scoreSession — SCORE-5', () => {
	it('sums round scores', () => {
		const rounds: RoundScoreInput[] = [
			{ title: correct(0), artist: correct(0), clipMs: CLIP },
			{ title: correct(CLIP), artist: missed, clipMs: CLIP }
		];
		expect(scoreSession(rounds, 'speed')).toBe(2000 + 100);
	});

	it('is zero for an empty session', () => {
		expect(scoreSession([], 'speed')).toBe(0);
	});

	it('produces identical totals for identical play — the leaderboard requirement', () => {
		const rounds: RoundScoreInput[] = [
			{ title: correct(1234), artist: correct(5678), clipMs: CLIP }
		];
		expect(scoreSession(rounds, 'speed')).toBe(scoreSession(rounds, 'speed'));
	});
});

describe('maxPossibleScore — §11 weekly normalization', () => {
	const rounds: RoundScoreInput[] = Array.from({ length: 5 }, () => ({ clipMs: CLIP }));

	it('counts two targets per round when guessing both', () => {
		expect(maxPossibleScore(rounds, 'both', 'speed')).toBe(5 * 2 * 1000);
	});

	it('counts one target per round for a single-target quiz', () => {
		expect(maxPossibleScore(rounds, 'title', 'speed')).toBe(5 * 1000);
		expect(maxPossibleScore(rounds, 'artist', 'fixed')).toBe(5 * 500);
	});

	it('excludes skipped rounds from the denominator', () => {
		const withSkip = [...rounds, { clipMs: CLIP, skipped: true }];
		expect(maxPossibleScore(withSkip, 'both', 'speed')).toBe(
			maxPossibleScore(rounds, 'both', 'speed')
		);
	});
});

describe('weeklyPoints — STAT-4', () => {
	it('normalizes to a 100-point scale', () => {
		expect(weeklyPoints(5_000, 10_000, false)).toBe(50);
		expect(weeklyPoints(10_000, 10_000, false)).toBe(100);
		expect(weeklyPoints(0, 10_000, false)).toBe(0);
	});

	it('doubles the daily', () => {
		expect(weeklyPoints(5_000, 10_000, true)).toBe(100);
	});

	it('keeps a 5-round daily comparable to a 20-round official quiz', () => {
		const daily = weeklyPoints(8_000, 10_000, false);
		const official = weeklyPoints(32_000, 40_000, false);
		expect(daily).toBe(official);
	});

	it('is zero rather than infinite when nothing was possible', () => {
		expect(weeklyPoints(100, 0, true)).toBe(0);
	});
});
