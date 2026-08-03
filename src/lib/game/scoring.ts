/**
 * Scoring curves — technical-spec §9 (SCORE-1…6).
 *
 * Curves are **versioned and frozen**. `curve_version` is stamped on the quiz and
 * on every session, so a board stays internally comparable for the quiz's whole
 * lifetime (SCORE-6). Changing scoring means adding `v2` to the registry — never
 * editing `v1`.
 */

export type ScoringMode = 'speed' | 'fixed';

export interface Curve {
	readonly version: number;
	/**
	 * Points for one correct guess target.
	 *
	 * @param lockMs elapsed clip time at lock-in, in ms
	 * @param clipMs the round's *measured* buffer duration (§9): preview lengths
	 *   are not uniformly 30 s, and a hardcoded denominator would hand a short
	 *   clip a steeper curve than its neighbours.
	 */
	readonly points: (mode: ScoringMode, lockMs: number, clipMs: number) => number;
	/** Ceiling for one correct target — the denominator of the weekly ladder's normalization (§11). */
	readonly maxPointsPerTarget: (mode: ScoringMode) => number;
}

const SPEED_MAX = 1000;
const SPEED_FLOOR = 100;
const FIXED_POINTS = 500;

const v1: Curve = {
	version: 1,
	points(mode, lockMs, clipMs) {
		if (!Number.isFinite(lockMs) || lockMs < 0) return 0;
		if (mode === 'fixed') return FIXED_POINTS;

		// A non-positive or unknown clip duration cannot produce an honest speed
		// score; award the floor rather than dividing by zero.
		if (!Number.isFinite(clipMs) || clipMs <= 0) return SPEED_FLOOR;

		const elapsed = Math.min(lockMs, clipMs);
		const decayed = SPEED_MAX - (SPEED_MAX - SPEED_FLOOR) * (elapsed / clipMs);
		return Math.max(SPEED_FLOOR, Math.round(decayed));
	},
	maxPointsPerTarget(mode) {
		return mode === 'fixed' ? FIXED_POINTS : SPEED_MAX;
	}
};

const CURVES: Record<number, Curve> = { 1: v1 };

/** The version stamped on newly created quizzes and sessions. */
export const CURRENT_CURVE_VERSION = 1;

export function getCurve(version: number): Curve {
	const curve = CURVES[version];
	if (!curve) throw new Error(`Unknown curve_version: ${version}`);
	return curve;
}

/** One guess target's outcome, as recorded in `round_result` (§6). */
export interface TargetResult {
	correct: boolean;
	/** Elapsed clip time at lock-in. Null when never answered correctly. */
	lockMs: number | null;
}

export interface RoundScoreInput {
	title?: TargetResult;
	artist?: TargetResult;
	/** Measured buffer duration for this round (`round_result.clip_ms`). */
	clipMs: number;
	/** MUS-5: a dead clip scores nothing and costs nothing. */
	skipped?: boolean;
}

/**
 * Score one round: the sum of its guess targets (SCORE-1). Unanswered or
 * never-corrected targets earn 0; there are no negative points (SCORE-4).
 *
 * A skipped round is excluded from the total entirely — it is displayed as "—",
 * and its session does not post to any board at all (§7.3 step 4, FAIR-6).
 */
export function scoreRound(
	input: RoundScoreInput,
	mode: ScoringMode,
	curveVersion: number = CURRENT_CURVE_VERSION
): number {
	if (input.skipped) return 0;

	const curve = getCurve(curveVersion);
	let total = 0;

	for (const target of [input.title, input.artist]) {
		if (!target?.correct || target.lockMs === null) continue;
		total += curve.points(mode, target.lockMs, input.clipMs);
	}

	return total;
}

/** Quiz total = sum of round scores (SCORE-5). */
export function scoreSession(
	rounds: readonly RoundScoreInput[],
	mode: ScoringMode,
	curveVersion: number = CURRENT_CURVE_VERSION
): number {
	return rounds.reduce((sum, round) => sum + scoreRound(round, mode, curveVersion), 0);
}

/**
 * The highest total a session *could* have reached, used to normalize the weekly
 * ladder so a 5-round daily stays comparable to a 20-round official quiz (§11).
 *
 * Skipped rounds are excluded from both numerator and denominator, which is moot
 * in practice — a session containing one never scores.
 */
export function maxPossibleScore(
	rounds: readonly RoundScoreInput[],
	guessTarget: 'both' | 'title' | 'artist',
	mode: ScoringMode,
	curveVersion: number = CURRENT_CURVE_VERSION
): number {
	const curve = getCurve(curveVersion);
	const targetsPerRound = guessTarget === 'both' ? 2 : 1;
	const playable = rounds.filter((round) => !round.skipped).length;
	return playable * targetsPerRound * curve.maxPointsPerTarget(mode);
}

/**
 * Weekly ladder contribution for a scored daily or official session (STAT-4, §11).
 *
 * The 100-point scale and the daily's ×2 weight are tunable constants — like
 * `curve_version`, changing them mid-week would distort a live board, so they
 * change only at a week boundary.
 */
export const WEEKLY_SCALE = 100;
export const WEEKLY_DAILY_MULTIPLIER = 2;

export function weeklyPoints(totalScore: number, maxPossible: number, isDaily: boolean): number {
	if (maxPossible <= 0) return 0;
	const normalized = Math.round((WEEKLY_SCALE * totalScore) / maxPossible);
	return isDaily ? normalized * WEEKLY_DAILY_MULTIPLIER : normalized;
}
