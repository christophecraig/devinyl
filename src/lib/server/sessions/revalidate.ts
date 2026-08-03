/**
 * Server-side re-validation — technical-spec §7.3.
 *
 * At finalize the server recomputes the **entire session from raw inputs**, using
 * the same shared `normalize`/`match`/`scoring` code the client ran for instant
 * feedback (§7.2). The client's claimed correctness is ignored outright; only
 * recomputed results count. That is what keeps casual forgery off the boards
 * while costing zero latency during play — it is the same pure functions, twice.
 *
 * This module is deliberately **pure**: it takes raw inputs and answer keys and
 * returns a verdict. All D1 access lives in `./index.ts`, so every branch below
 * is unit-testable without a database.
 */

import { match } from '$lib/game/match.js';
import {
	getCurve,
	type ScoringMode,
	type TargetResult,
	scoreRound as scoreRoundPoints
} from '$lib/game/scoring.js';
import type {
	AnswerKey,
	FinalizedRound,
	GuessLog,
	GuessAttempt,
	GuessTarget,
	ScoredBlockReason,
	TargetName
} from '$lib/game/types.js';

/** §7.3 step 3 — network tolerance on every timing comparison. */
const NETWORK_TOLERANCE_MS = 2_000;

/** §7.3 step 3 — how far a claimed clipMs may stray from the known preview duration. */
const CLIP_TOLERANCE_MS = 2_000;

export interface RevalidateRoundInput {
	position: number;
	guessLog: GuessLog;
	/** What the client claimed. Cross-checked, never trusted. */
	lockTimes: Partial<Record<TargetName, number>>;
	clipMs: number;
	skipped: boolean;
	/** Precomputed accepted answers from `track_cache.answers` (§5.4). */
	answers: AnswerKey;
	/** Server-known preview duration, if we have one. Null ⇒ that check is skipped. */
	knownPreviewMs: number | null;
	/** Server receipt time of this round's result POST, if observed. */
	serverReceivedAt: number | null;
}

export interface RevalidateInput {
	rounds: RevalidateRoundInput[];
	guessTarget: GuessTarget;
	scoringMode: ScoringMode;
	curveVersion: number;
	/** Server-observed round-start beacons (§7.1). May be empty — an offline run has none. */
	serverRoundLog: { position: number; at: number }[];
	startedAt: number;
	finalizedAt: number;
}

/**
 * Which evidence tier the run cleared (§7.3 step 3).
 *
 * `verified` — a server-observed beacon bounds every round.
 * `reconstructed` — beacons were late or absent; the run satisfies invariants
 *   that survive offline play. **Failing only the verified tier is not
 *   disqualifying**, because MUS-7 promises play survives a connection drop and
 *   punishing that would make the offline guarantee a trap.
 * `none` — no timing evidence at all.
 */
export type PlausibilityTier = 'verified' | 'reconstructed' | 'none';

export interface RevalidateResult {
	rounds: FinalizedRound[];
	totalScore: number;
	maxPossibleScore: number;
	tier: PlausibilityTier;
	/** Null when nothing blocks scoring on *timing/clip* grounds. Identity checks (FAIR-1/2/7) happen in the caller. */
	blockReason: ScoredBlockReason | null;
	/** Human-readable notes for the /admin flagged-sessions view (§15). Never shown to the player. */
	notes: string[];
}

const isTargetPlayed = (guessTarget: GuessTarget, target: TargetName): boolean =>
	guessTarget === 'both' || guessTarget === target;

/**
 * Find the earliest attempt at `target` that actually matches, per the shared
 * matcher. This is what replaces the client's claim: correctness *and* lock time
 * both come from the raw log.
 */
function resolveTarget(
	guessLog: GuessLog,
	target: TargetName,
	accepted: readonly string[]
): TargetResult {
	let earliest: number | null = null;

	for (const attempt of guessLog) {
		if (attempt.target !== target) continue;
		if (!match(attempt.raw, accepted)) continue;
		if (earliest === null || attempt.atMs < earliest) earliest = attempt.atMs;
	}

	return { correct: earliest !== null, lockMs: earliest };
}

/** Timestamps within a round must not go backwards. */
function isMonotonic(guessLog: GuessLog): boolean {
	for (let i = 1; i < guessLog.length; i++) {
		if (guessLog[i].atMs < guessLog[i - 1].atMs) return false;
	}
	return true;
}

const withinClip = (attempt: GuessAttempt, clipMs: number): boolean =>
	attempt.atMs >= 0 && attempt.atMs <= clipMs + NETWORK_TOLERANCE_MS;

/**
 * Invariants that survive offline play (§7.3 step 3, reconstructed tier).
 * Returns the reasons it failed, empty when it holds.
 */
function checkReconstructedInvariants(input: RevalidateInput): string[] {
	const failures: string[] = [];

	// Rounds arrive in order.
	const positions = input.rounds.map((r) => r.position);
	for (let i = 1; i < positions.length; i++) {
		if (positions[i] <= positions[i - 1]) {
			failures.push(`rounds out of order at index ${i}`);
			break;
		}
	}

	let claimedDurationTotal = 0;

	for (const round of input.rounds) {
		if (round.skipped) continue;

		// A claimed clipMs cannot stray from the duration we know the preview to
		// have, or it could be inflated to buy a gentler curve.
		if (
			round.knownPreviewMs !== null &&
			Math.abs(round.clipMs - round.knownPreviewMs) > CLIP_TOLERANCE_MS
		) {
			failures.push(
				`round ${round.position}: clipMs ${round.clipMs} vs known ${round.knownPreviewMs}`
			);
		}

		if (!isMonotonic(round.guessLog)) {
			failures.push(`round ${round.position}: guess timestamps not monotonic`);
		}

		for (const attempt of round.guessLog) {
			if (!withinClip(attempt, round.clipMs)) {
				failures.push(`round ${round.position}: attempt at ${attempt.atMs} outside [0, clipMs]`);
				break;
			}
		}

		// Every claimed lock time must sit inside the clip.
		for (const [target, lockMs] of Object.entries(round.lockTimes)) {
			if (lockMs === undefined) continue;
			if (lockMs < 0 || lockMs > round.clipMs + NETWORK_TOLERANCE_MS) {
				failures.push(`round ${round.position}: ${target} lock ${lockMs} outside [0, clipMs]`);
			}
		}

		claimedDurationTotal += round.clipMs;
	}

	// Wall-clock sanity: the session cannot have taken less time than the clips it
	// claims to have played.
	const wallClock = input.finalizedAt - input.startedAt;
	if (wallClock + NETWORK_TOLERANCE_MS < claimedDurationTotal) {
		failures.push(`wall clock ${wallClock}ms < claimed clip total ${claimedDurationTotal}ms`);
	}

	return failures;
}

/**
 * Verified tier: a server-observed beacon bounds each round. The claimed elapsed
 * time must fit between that beacon and the next observation (+ tolerance).
 */
function checkVerifiedTier(input: RevalidateInput): { covered: number; failures: string[] } {
	const beacons = new Map(input.serverRoundLog.map((b) => [b.position, b.at]));
	const failures: string[] = [];
	let covered = 0;

	for (const round of input.rounds) {
		const beaconAt = beacons.get(round.position);
		if (beaconAt === undefined) continue;
		covered++;

		// The round is bounded by the next beacon, or failing that by the server's
		// receipt of its result, or failing that by finalize.
		const nextBeacon = input.serverRoundLog
			.filter((b) => b.position > round.position)
			.reduce<number | null>((min, b) => (min === null || b.at < min ? b.at : min), null);
		const upperBound = nextBeacon ?? round.serverReceivedAt ?? input.finalizedAt;

		const latestClaim = Math.max(
			0,
			...round.guessLog.map((a) => a.atMs),
			...Object.values(round.lockTimes).filter((t): t is number => t !== undefined)
		);

		if (beaconAt + latestClaim > upperBound + NETWORK_TOLERANCE_MS) {
			failures.push(
				`round ${round.position}: claimed ${latestClaim}ms exceeds observed window ${upperBound - beaconAt}ms`
			);
		}
	}

	return { covered, failures };
}

/**
 * Recompute a whole session and decide whether it may post to a board.
 *
 * Identity-based blocks (FAIR-1 creator, FAIR-2 replay, FAIR-7 guest daily) are
 * **not** decided here — they need database lookups and are applied by the
 * caller, which takes precedence over anything this function returns.
 */
export function revalidateSession(input: RevalidateInput): RevalidateResult {
	const curve = getCurve(input.curveVersion);
	const notes: string[] = [];

	const rounds: FinalizedRound[] = [];
	let totalScore = 0;
	let playableRounds = 0;
	let anySkipped = false;

	for (const round of input.rounds) {
		if (round.skipped) {
			anySkipped = true;
			rounds.push({
				position: round.position,
				titleOk: null,
				artistOk: null,
				skipped: true,
				clipMs: round.clipMs,
				titleMs: null,
				artistMs: null,
				points: 0
			});
			continue;
		}

		playableRounds++;

		const title = isTargetPlayed(input.guessTarget, 'title')
			? resolveTarget(round.guessLog, 'title', round.answers.title)
			: null;
		const artist = isTargetPlayed(input.guessTarget, 'artist')
			? resolveTarget(round.guessLog, 'artist', round.answers.artist)
			: null;

		// Flag any place the client's claim disagreed with our recomputation. Not
		// disqualifying on its own — a client bug looks the same as a fiddle — but
		// worth surfacing on the /admin view.
		for (const [name, resolved] of [
			['title', title],
			['artist', artist]
		] as const) {
			const claimed = round.lockTimes[name];
			if (claimed !== undefined && resolved?.lockMs === null) {
				notes.push(`round ${round.position}: client claimed a ${name} lock we could not reproduce`);
			}
		}

		const points = scoreRoundPoints(
			{
				title: title ?? undefined,
				artist: artist ?? undefined,
				clipMs: round.clipMs
			},
			input.scoringMode,
			input.curveVersion
		);
		totalScore += points;

		rounds.push({
			position: round.position,
			titleOk: title ? title.correct : null,
			artistOk: artist ? artist.correct : null,
			skipped: false,
			clipMs: round.clipMs,
			titleMs: title?.lockMs ?? null,
			artistMs: artist?.lockMs ?? null,
			points
		});
	}

	// --- plausibility (§7.3 step 3) ---

	const invariantFailures = checkReconstructedInvariants(input);
	const verified = checkVerifiedTier(input);

	let tier: PlausibilityTier;
	if (verified.covered === input.rounds.length && verified.covered > 0) {
		tier = 'verified';
	} else if (verified.covered > 0 || input.rounds.some((r) => r.serverReceivedAt !== null)) {
		tier = 'reconstructed';
	} else {
		tier = 'none';
	}

	notes.push(...verified.failures.map((f) => `verified-tier: ${f}`));
	notes.push(...invariantFailures.map((f) => `invariant: ${f}`));

	// --- the verdict (§7.3 step 4) ---

	let blockReason: ScoredBlockReason | null = null;

	if (anySkipped) {
		// MUS-5: a session containing a skipped round completes and shows its score,
		// but is not comparable to other players' runs, so it never posts.
		blockReason = 'clip_unavailable';
	} else if (invariantFailures.length > 0) {
		// The reconstructed tier is the floor. Failing it is disqualifying — shown
		// to the player as a generic "couldn't be verified", never an accusation
		// (FAIR-4 posture).
		blockReason = 'implausible';
	} else if (tier === 'none') {
		blockReason = 'unverified_timing';
	}
	// Note: failing *only* the verified tier is deliberately not disqualifying.

	const targetsPerRound = input.guessTarget === 'both' ? 2 : 1;
	const maxPossibleScore =
		playableRounds * targetsPerRound * curve.maxPointsPerTarget(input.scoringMode);

	return { rounds, totalScore, maxPossibleScore, tier, blockReason, notes };
}
