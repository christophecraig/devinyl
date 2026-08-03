/**
 * `POST /api/sessions/:id/finalize` — technical-spec §7.3, plan task 1.16.
 *
 * This is the module that turns a played-through session into an authoritative
 * score. The heavy lifting — re-running `normalize`/`match` on the raw guess
 * log, recomputing points from `lockTimes`/`clipMs`, and the two-tier
 * plausibility check — already lives in `./revalidate.ts`, which is pure and
 * takes no DB. Everything here is the D1-shaped wrapper around it:
 *
 *   1. Load the session, idempotently short-circuiting a retried finalize
 *      (MUS-7: a failing finalize is retried from `localStorage` on next
 *      visit, so this endpoint **will** be called twice for the same run).
 *   2. Persist any last-chance round-result flush the body carries (offline
 *      finish never reached `rounds/:n/result` for one or more rounds).
 *   3. Build `RevalidateInput` from `round_result` + `track_cache` and call
 *      the pure engine.
 *   4. Apply the identity-based blocks the engine deliberately leaves out —
 *      creator (FAIR-1), replay (FAIR-2), guest-daily (FAIR-7) — which take
 *      precedence over the engine's tier/blockReason (`revalidate.ts`'s own
 *      contract statement).
 *   5. Persist the verdict, promote an ephemeral quiz on a scored use (§6),
 *      credit the weekly ladder (STAT-4, §11), and return a `FinalizeResult`.
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FinalizeSessionBody } from '$lib/game/schemas.js';
import type { FinalizedRound, FinalizeResult, ScoredBlockReason } from '$lib/game/types.js';
import type { Db } from '../db/index.js';
import {
	dailyGuestClaim,
	gameSession,
	quiz,
	quizTrack,
	roundResult,
	trackCache,
	user,
	weeklyPoints
} from '../db/schema.js';
import { parisIsoWeek } from '../time.js';
import type { Player } from '../identity.js';
import { loadOwnedSession } from './create.js';
import { loadRoundResults, mergeQueuedBeacons, recordRoundResult } from './rounds.js';
import {
	revalidateSession,
	type RevalidateInput,
	type RevalidateRoundInput
} from './revalidate.js';

type SessionRow = typeof gameSession.$inferSelect;
type QuizRow = typeof quiz.$inferSelect;
type RoundResultRow = typeof roundResult.$inferSelect;

// ---------------------------------------------------------------------------
// Pure decision logic — no DB, exercised directly by finalize.test.ts.
// ---------------------------------------------------------------------------

/**
 * Everything the identity layer decided, gathered from separate DB lookups so
 * the precedence rule itself stays a one-line pure function.
 */
export interface IdentityBlockInput {
	/** FAIR-1: quiz owner, or an operator on an official/daily quiz. */
	isCreator: boolean;
	/** FAIR-2: a prior scored session already exists for this (player, quiz[, challenge|daily]). */
	hasPriorScoredRun: boolean;
	/** FAIR-7: a guest daily claim for this (day, ipHash) already belongs to a different guestId. */
	guestDailyReplay: boolean;
}

/**
 * FAIR-1 beats FAIR-2/7 in practice because a creator replaying their own quiz
 * is *always* `'creator'`, never `'replay'` — the reason shown to the player
 * should name the actual disqualifying fact, and "you made this" is the more
 * informative one. Between FAIR-2 and FAIR-7 there is no observable
 * precedence: a session can trigger at most one of them (FAIR-7 only applies
 * to guests, whose FAIR-2 identity is the same guestId that just claimed).
 */
export function resolveIdentityBlock(input: IdentityBlockInput): ScoredBlockReason | null {
	if (input.isCreator) return 'creator';
	if (input.hasPriorScoredRun || input.guestDailyReplay) return 'replay';
	return null;
}

/**
 * §7.3 step 4/5 combined: identity blocks are decided by the caller (here) and
 * **take precedence over** the engine's own tier-derived `blockReason` —
 * `revalidate.ts`'s contract statement, made concrete. A session can be
 * perfectly plausible and still not score because it's a replay.
 */
export function applyIdentityPrecedence(
	identityBlock: ScoredBlockReason | null,
	engineBlockReason: ScoredBlockReason | null
): { scored: boolean; blockReason: ScoredBlockReason | null } {
	const blockReason = identityBlock ?? engineBlockReason;
	return { scored: blockReason === null, blockReason };
}

/** FAIR-1: the quiz owner, or an operator account on an official/daily quiz they curate. */
export function isCreatorOfQuiz(
	player: Player,
	quizRow: { ownerId: string | null; kind: string },
	isOperator: boolean
): boolean {
	if (player.kind !== 'user') return false;
	if (quizRow.ownerId === player.userId) return true;
	return isOperator && (quizRow.kind === 'official' || quizRow.kind === 'daily');
}

/**
 * STAT-4 / §11 weekly-ladder contribution: normalized to a 100-point scale so
 * a 5-round daily is comparable to a 20-round official quiz, weighted ×2 for
 * the daily. Pure so the formula's boundary values (0 max, perfect score,
 * rounding) are unit-testable without touching `weekly_points`.
 */
export function weeklyContribution(
	totalScore: number,
	maxPossibleScore: number,
	isDaily: boolean
): number {
	if (maxPossibleScore <= 0) return 0;
	const base = Math.round((100 * totalScore) / maxPossibleScore);
	return isDaily ? base * 2 : base;
}

// ---------------------------------------------------------------------------
// FAIR-7 — guest daily dedupe (§7.3 step 6, §6, §16)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * §6: `ip_hash = HMAC(server_secret ‖ day, ip)` — day-salted so a value is
 * unlinkable across days, and **keyed** so it cannot be inverted.
 *
 * The key is the point. An unkeyed digest of an IP is not a pseudonym: IPv4 is
 * 2³² values, a single GPU walks the whole space in seconds, and a per-day salt
 * doesn't help when the day is public. Only a secret the attacker doesn't hold
 * makes this table safe to keep — and we keep it for 48 h (1.17), so it must be
 * safe at rest.
 *
 * The key is derived per call rather than cached: `importKey` is cheap next to
 * the D1 round-trip that follows, and FAIR-7 runs at most once per finalize.
 */
async function hashGuestIp(secret: string, day: string, ip: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	// The day goes in the message, not the key: same key, distinct namespace per
	// day, so yesterday's hashes can't be matched against today's.
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`devinyl/fair7/${day}/${ip}`));
	return toHex(new Uint8Array(mac));
}

/**
 * Insert this guest's daily claim, or detect that the (day, ipHash) pair is
 * already claimed by a *different* guestId — which per §7.3 step 6 means the
 * local guest id was reset, and this run is a replay. Fails open (returns
 * "not a replay") on any DB error, matching FAIR-7's coarse-by-design posture:
 * a limiter/dedupe outage must not cost a player their run.
 */
async function checkAndClaimGuestDaily(
	db: Db,
	secret: string,
	day: string,
	ip: string,
	guestId: string
): Promise<boolean> {
	try {
		const ipHash = await hashGuestIp(secret, day, ip);
		const [existing] = await db
			.select({ guestId: dailyGuestClaim.guestId })
			.from(dailyGuestClaim)
			.where(and(eq(dailyGuestClaim.day, day), eq(dailyGuestClaim.ipHash, ipHash)))
			.limit(1);

		if (existing) return existing.guestId !== guestId;

		await db.insert(dailyGuestClaim).values({ day, ipHash, guestId });
		return false;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Assembling RevalidateInput from stored rows
// ---------------------------------------------------------------------------

interface RoundKey {
	answers: { title: string[]; artist: string[] };
	knownPreviewMs: number | null;
}

/**
 * One round per `quiz_track` row — the manifest's own round list — not one
 * per `round_result` row. A round whose result never reached the server (dead
 * connection, and this finalize carries no flush entry for it either) still
 * needs to enter the engine as `skipped`, or it would silently vanish from
 * `maxPossibleScore` instead of costing the session its board eligibility
 * (MUS-5).
 */
interface RevalidateRounds {
	rounds: RevalidateRoundInput[];
	/** Positions that already had a `round_result` row — the rest were synthesized as skipped. */
	knownPositions: Set<number>;
}

async function loadRevalidateRounds(
	db: Db,
	quizId: string,
	sessionId: string
): Promise<RevalidateRounds> {
	const tracks = await db
		.select({
			position: quizTrack.position,
			answers: trackCache.answers,
			previewMs: trackCache.previewMs
		})
		.from(quizTrack)
		.innerJoin(trackCache, eq(quizTrack.trackId, trackCache.id))
		.where(eq(quizTrack.quizId, quizId));

	const keys = new Map<number, RoundKey>(
		tracks.map((t) => [t.position, { answers: t.answers, knownPreviewMs: t.previewMs }])
	);

	const results = await loadRoundResults(db, sessionId);
	const byPosition = new Map<number, RoundResultRow>(results.map((r) => [r.position, r]));

	const positions = [...keys.keys()].sort((a, b) => a - b);

	const rounds = positions.map((position): RevalidateRoundInput => {
		const key = keys.get(position) ?? { answers: { title: [], artist: [] }, knownPreviewMs: null };
		const row = byPosition.get(position);

		if (!row) {
			// No result ever arrived for this round — treat it exactly like a
			// client-reported skip (§7.3 step 4, MUS-5).
			return {
				position,
				guessLog: [],
				lockTimes: {},
				clipMs: 0,
				skipped: true,
				answers: key.answers,
				knownPreviewMs: key.knownPreviewMs,
				serverReceivedAt: null
			};
		}

		return {
			position: row.position,
			guessLog: row.guessLog,
			lockTimes: {
				...(row.claimedTitleMs !== null ? { title: row.claimedTitleMs } : {}),
				...(row.claimedArtistMs !== null ? { artist: row.claimedArtistMs } : {})
			},
			clipMs: row.clipMs,
			skipped: row.skipped,
			answers: key.answers,
			knownPreviewMs: key.knownPreviewMs,
			serverReceivedAt: row.serverReceivedAt
		};
	});

	return { rounds, knownPositions: new Set(byPosition.keys()) };
}

// ---------------------------------------------------------------------------
// Identity blocks (DB-backed side of the pure functions above)
// ---------------------------------------------------------------------------

async function loadIsOperator(db: Db, player: Player): Promise<boolean> {
	if (player.kind !== 'user') return false;
	const [row] = await db
		.select({ isOperator: user.isOperator })
		.from(user)
		.where(eq(user.id, player.userId))
		.limit(1);
	return row?.isOperator ?? false;
}

/**
 * FAIR-2: is there already a scored session for this exact (player, quiz[,
 * challenge|daily]) combination? Scoped by whichever of `challengeToken` /
 * `dailyDay` this session carries, mirroring the board indexes (§6) — a
 * quiz's generic board, its per-challenge boards, and the daily board each
 * get their own first-run check, matching how each is a separate board.
 */
async function hasPriorScoredRun(db: Db, session: SessionRow, player: Player): Promise<boolean> {
	const identity =
		player.kind === 'user'
			? eq(gameSession.userId, player.userId)
			: eq(gameSession.guestId, player.guestId);

	const scope = session.challengeToken
		? eq(gameSession.challengeToken, session.challengeToken)
		: isNull(gameSession.challengeToken);
	const dailyScope = session.dailyDay
		? eq(gameSession.dailyDay, session.dailyDay)
		: isNull(gameSession.dailyDay);

	const [row] = await db
		.select({ id: gameSession.id })
		.from(gameSession)
		.where(
			and(
				identity,
				eq(gameSession.quizId, session.quizId),
				scope,
				dailyScope,
				eq(gameSession.scored, true),
				ne(gameSession.id, session.id)
			)
		)
		.limit(1);

	return Boolean(row);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface FinalizeSessionInput {
	sessionId: string;
	player: Player;
	body: FinalizeSessionBody;
	/** FAIR-7 needs the requester's IP; only consulted for a guest finalizing a daily session. */
	clientIp: string;
	/** Keys the FAIR-7 IP hash (`IP_HASH_SECRET`). Required, so the hash can never silently degrade to an invertible digest. */
	ipHashSecret: string;
	now?: number;
}

function toFinalizedRounds(rows: RoundResultRow[]): FinalizedRound[] {
	return rows.map((r) => ({
		position: r.position,
		titleOk: r.titleOk,
		artistOk: r.artistOk,
		skipped: r.skipped,
		clipMs: r.clipMs,
		titleMs: r.titleMs,
		artistMs: r.artistMs,
		points: r.points
	}));
}

/** Reassemble the already-stored verdict for a retried finalize — no recomputation, no re-write. */
async function loadStoredResult(db: Db, session: SessionRow): Promise<FinalizeResult> {
	const rows = await loadRoundResults(db, session.id);
	return {
		sessionId: session.id,
		totalScore: session.totalScore ?? 0,
		rounds: toFinalizedRounds(rows),
		scored: session.scored,
		scoredBlockReason: session.scoredBlockReason,
		effectiveScoringMode: session.effectiveScoringMode,
		curveVersion: session.curveVersion,
		finalizedAt: session.finalizedAt ?? 0
	};
}

/**
 * Persist the engine's per-round recomputation. Rounds `round_result` already
 * holds (posted during play, or just flushed above) are updated in place;
 * a round that never posted at all (see `loadRevalidateRounds`) gets a fresh
 * row so the player's result view has one row per manifest round.
 */
async function persistRounds(
	db: Db,
	sessionId: string,
	rounds: FinalizedRound[],
	knownPositions: Set<number>
): Promise<void> {
	await Promise.all(
		rounds.map((round) => {
			if (knownPositions.has(round.position)) {
				return db
					.update(roundResult)
					.set({
						titleOk: round.titleOk,
						artistOk: round.artistOk,
						titleMs: round.titleMs,
						artistMs: round.artistMs,
						points: round.points
					})
					.where(
						and(eq(roundResult.sessionId, sessionId), eq(roundResult.position, round.position))
					);
			}

			return db.insert(roundResult).values({
				sessionId,
				position: round.position,
				titleOk: round.titleOk,
				artistOk: round.artistOk,
				skipped: round.skipped,
				clipMs: round.clipMs,
				titleMs: round.titleMs,
				artistMs: round.artistMs,
				points: round.points,
				guessLog: [],
				claimedTitleMs: null,
				claimedArtistMs: null,
				serverReceivedAt: null
			});
		})
	);
}

export async function finalizeSession(
	db: Db,
	input: FinalizeSessionInput
): Promise<FinalizeResult> {
	const now = input.now ?? Date.now();

	let session = await loadOwnedSession(db, input.sessionId, input.player);

	// Idempotency: a finalize that failed to reach the client (or one retried
	// from `localStorage`, §4) must not double-score or 409 in the player's
	// face. `finalizedAt` is the source of truth, not `status`, because the
	// spec's `status` enum has no 'finalized' value — only 'active' /
	// 'completed' / 'abandoned' (§6) — so "already finalized" is read off the
	// timestamp that step 5 below stamps exactly once.
	if (session.finalizedAt !== null) {
		return loadStoredResult(db, session);
	}

	// Step 2: last-chance flush (MUS-7 offline finish) — persist before revalidating.
	if (input.body.rounds && input.body.rounds.length > 0) {
		await Promise.all(input.body.rounds.map((round) => recordRoundResult(db, session, round, now)));

		const queuedBeacons = input.body.rounds.flatMap((round) => round.queuedBeacons ?? []);
		if (queuedBeacons.length > 0) {
			await mergeQueuedBeacons(db, session, queuedBeacons, now);
			// Re-read: mergeQueuedBeacons wrote server_round_log from the row it was
			// given, so the in-memory `session` is now stale for that column.
			session = await loadOwnedSession(db, input.sessionId, input.player);
		}
	}

	const [quizRow] = await db.select().from(quiz).where(eq(quiz.id, session.quizId)).limit(1);
	if (!quizRow) {
		// The quiz FK is never cascaded away (§6 deletion semantics) — this would
		// indicate real data corruption, not a normal player-facing condition.
		throw new Error(`finalize: quiz ${session.quizId} missing for session ${session.id}`);
	}

	const { rounds, knownPositions } = await loadRevalidateRounds(db, session.quizId, session.id);

	const revalidateInput: RevalidateInput = {
		rounds,
		guessTarget: quizRow.guessTarget,
		scoringMode: session.effectiveScoringMode,
		curveVersion: session.curveVersion,
		serverRoundLog: session.serverRoundLog ?? [],
		startedAt: session.startedAt,
		finalizedAt: now
	};

	const engineResult = revalidateSession(revalidateInput);

	// Step 4 — identity blocks the pure engine deliberately leaves out.
	const [isOperator, priorScoredRun, guestDailyReplay] = await Promise.all([
		loadIsOperator(db, input.player),
		hasPriorScoredRun(db, session, input.player),
		input.player.kind === 'guest' && session.dailyDay !== null
			? checkAndClaimGuestDaily(
					db,
					input.ipHashSecret,
					session.dailyDay,
					input.clientIp,
					input.player.guestId
				)
			: Promise.resolve(false)
	]);

	const identityBlock = resolveIdentityBlock({
		isCreator: isCreatorOfQuiz(input.player, quizRow, isOperator),
		hasPriorScoredRun: priorScoredRun,
		guestDailyReplay
	});
	const { scored, blockReason } = applyIdentityPrecedence(identityBlock, engineResult.blockReason);

	// Step 5 — persist. The player always sees their score (FAIR-6) even when
	// `scored` is false — only board eligibility is at stake.
	await persistRounds(db, session.id, engineResult.rounds, knownPositions);

	await db
		.update(gameSession)
		.set({
			status: 'completed',
			scored,
			scoredBlockReason: blockReason,
			totalScore: engineResult.totalScore,
			finalizedAt: now
		})
		.where(eq(gameSession.id, session.id));

	// Step 6/7 — only on an actually scored run.
	if (scored) {
		await promoteEphemeralQuizOnUse(db, quizRow);
		await creditWeeklyLadder(
			db,
			session,
			quizRow,
			input.player,
			engineResult.totalScore,
			engineResult.maxPossibleScore,
			now
		);
	}

	return {
		sessionId: session.id,
		totalScore: engineResult.totalScore,
		rounds: engineResult.rounds,
		scored,
		scoredBlockReason: blockReason,
		effectiveScoringMode: session.effectiveScoringMode,
		curveVersion: session.curveVersion,
		finalizedAt: now
	};
}

/**
 * §6 "Promotion on use": finalizing any scored session on an ephemeral quiz
 * clears `ephemeral_until` unconditionally, so the hourly sweep (§15,
 * `jobs/index.ts`) can never delete a quiz someone actually played and
 * scored on — its board would otherwise be pulled out from under it.
 */
async function promoteEphemeralQuizOnUse(db: Db, quizRow: QuizRow): Promise<void> {
	if (quizRow.ephemeralUntil === null) return;
	await db.update(quiz).set({ ephemeralUntil: null }).where(eq(quiz.id, quizRow.id));
}

/** STAT-4 / §11: scored daily or official sessions credit the weekly ladder. Guests have no weekly row. */
async function creditWeeklyLadder(
	db: Db,
	session: SessionRow,
	quizRow: QuizRow,
	player: Player,
	totalScore: number,
	maxPossibleScore: number,
	now: number
): Promise<void> {
	if (player.kind !== 'user') return;
	if (quizRow.kind !== 'daily' && quizRow.kind !== 'official') return;

	const contribution = weeklyContribution(totalScore, maxPossibleScore, session.dailyDay !== null);
	if (contribution === 0) return;

	const week = parisIsoWeek(now);
	await db
		.insert(weeklyPoints)
		.values({ userId: player.userId, week, points: contribution })
		.onConflictDoUpdate({
			target: [weeklyPoints.userId, weeklyPoints.week],
			set: { points: sql`${weeklyPoints.points} + ${contribution}` }
		});
}
