/**
 * Single entry point cron triggers are meant to dispatch into (plan
 * deviation table: "In-process setInterval jobs" -> "Cron Triggers", same
 * job code behind one runJobs(kind) entry). Job bodies land in Phase 1
 * (1.17) and later phases (3.1, 3.8, 3.11, 4.2) — the `every-15-min` batch
 * is implemented here; `daily` is still a stub.
 *
 * Every job in a batch is failure-isolated (`runOne` below): one throwing
 * job must not stop the others from running, and every job is bounded by
 * `BATCH_SIZE` so a single 15-minute tick can't blow the Workers CPU budget
 * or the D1 free tier's 100k writes/day.
 *
 * The individual sweep/purge functions are exported alongside `runJobs`
 * purely so `index.test.ts` can drive them against a hand-rolled fake `Db`
 * — this package has no D1-backed unit-test harness (that's what
 * `*.integration.test.ts` + miniflare is for), so a real query round-trip
 * isn't available at this layer.
 */

import { and, eq, inArray, isNotNull, lt, notExists, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.js';
import {
	challenge,
	dailyGuestClaim,
	dailyQuiz,
	gameSession,
	quiz,
	quizTrack,
	rateLimit
} from '../db/schema.js';

export type JobKind = 'every-15-min' | 'hourly' | 'daily';

/** Per-invocation cap — see the module comment. Every job below reads at most this many rows. */
const BATCH_SIZE = 200;

/** ROUND-8: an `active` session untouched this long is swept, not scored. */
const ABANDONED_SESSION_AGE_MS = 2 * 60 * 60 * 1000;

/** §6/FAIR-7: `daily_guest_claim` rows outlive their dedupe purpose after 48 h. */
const DAILY_GUEST_CLAIM_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * §10/ratelimit.ts: the longest fixed window in `LIMITS` is 60 s, so any
 * window row is dead weight a minute after it starts. A 1 h margin is
 * comfortable slack against a future longer window without needing this
 * job to know each bucket's `windowMs`.
 */
const RATE_LIMIT_WINDOW_MARGIN_MS = 60 * 60 * 1000;

/**
 * ROUND-8: sessions left `active` for 2 h are presumed abandoned — the
 * player closed the tab mid-quiz. Swept **out of `active`**, so a late
 * round-result POST 409s via `loadActiveSession` instead of extending a run
 * nobody is there to play.
 *
 * Finalize is deliberately the exception: it accepts an abandoned session so
 * the §4 offline-retry path can still return the player their score, and
 * blocks it from the boards with `'abandoned'` instead (see
 * `sessions/finalize.ts`). Sweeping is therefore not a hard discard — it is
 * the point at which a run stops being playable and stops being scoreable.
 *
 * Bounded via select-then-update (rather than a single UPDATE ... LIMIT,
 * which SQLite/D1 doesn't support without a nonstandard compile flag) so
 * one tick can't attempt an unbounded write.
 */
export async function sweepAbandonedSessions(db: Db, now: number): Promise<number> {
	const cutoff = now - ABANDONED_SESSION_AGE_MS;
	const stale = await db
		.select({ id: gameSession.id })
		.from(gameSession)
		.where(and(eq(gameSession.status, 'active'), lt(gameSession.startedAt, cutoff)))
		.limit(BATCH_SIZE);

	if (stale.length === 0) return 0;

	await db
		.update(gameSession)
		.set({ status: 'abandoned' })
		.where(
			inArray(
				gameSession.id,
				stale.map((row) => row.id)
			)
		);

	return stale.length;
}

/**
 * §6/§15: `quiz` rows of `kind='generated'` carry a 24 h `ephemeral_until`
 * TTL, cleared unconditionally the moment the quiz is *used* — saved,
 * challenged, or played to a scored finish (promotion, §6). So anything
 * still past its TTL is, by construction, unplayed and unreferenced —
 * a leaf row.
 *
 * This job re-checks that leaf property explicitly with `NOT EXISTS`
 * against every table that can reference a quiz (`game_session`,
 * `challenge`, `daily_quiz`) rather than trusting the TTL alone: D1's FK
 * enforcement is a runtime PRAGMA, not a compile-time guarantee, and a
 * quiz someone actually played must survive even if promotion somehow
 * failed to clear the TTL. `quiz_track` children are deleted before the
 * parent for the same reason — cascade is declared in the schema, but this
 * job doesn't lean on it.
 */
export async function sweepEphemeralQuizzes(db: Db, now: number): Promise<number> {
	const leaves = await db
		.select({ id: quiz.id })
		.from(quiz)
		.where(
			and(
				eq(quiz.kind, 'generated'),
				isNotNull(quiz.ephemeralUntil),
				lt(quiz.ephemeralUntil, now),
				notExists(
					db
						.select({ one: sql`1` })
						.from(gameSession)
						.where(eq(gameSession.quizId, quiz.id))
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(challenge)
						.where(eq(challenge.quizId, quiz.id))
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(dailyQuiz)
						.where(eq(dailyQuiz.quizId, quiz.id))
				)
			)
		)
		.limit(BATCH_SIZE);

	if (leaves.length === 0) return 0;

	const ids = leaves.map((row) => row.id);
	await db.delete(quizTrack).where(inArray(quizTrack.quizId, ids));
	await db.delete(quiz).where(inArray(quiz.id, ids));

	return ids.length;
}

/**
 * FAIR-7/§16: `daily_guest_claim` exists only to dedupe a guest's daily
 * attempt for the day it was written; past 48 h it's stale data with no
 * remaining purpose, so it's purged rather than retained (§16 inventory).
 *
 * Bounded via select-then-delete on the table's composite PK, same
 * reasoning as the session sweep.
 */
export async function purgeDailyGuestClaims(db: Db, now: number): Promise<number> {
	const cutoff = now - DAILY_GUEST_CLAIM_AGE_MS;
	const stale = await db
		.select({ day: dailyGuestClaim.day, ipHash: dailyGuestClaim.ipHash })
		.from(dailyGuestClaim)
		.where(lt(dailyGuestClaim.createdAt, cutoff))
		.limit(BATCH_SIZE);

	if (stale.length === 0) return 0;

	for (const row of stale) {
		await db
			.delete(dailyGuestClaim)
			.where(and(eq(dailyGuestClaim.day, row.day), eq(dailyGuestClaim.ipHash, row.ipHash)));
	}

	return stale.length;
}

/**
 * ratelimit.ts writes one `rate_limit` row per key per window and nothing
 * else ever deletes them — left alone the table only grows. Every window is
 * at most 60 s wide today, so anything older than `RATE_LIMIT_WINDOW_MARGIN_MS`
 * is long past mattering to `consume`'s upsert.
 *
 * Bounded via select-then-delete on the table's composite PK, same
 * reasoning as the other sweeps.
 */
export async function purgeRateLimitWindows(db: Db, now: number): Promise<number> {
	const cutoff = now - RATE_LIMIT_WINDOW_MARGIN_MS;
	const stale = await db
		.select({ key: rateLimit.key, windowStart: rateLimit.windowStart })
		.from(rateLimit)
		.where(lt(rateLimit.windowStart, cutoff))
		.limit(BATCH_SIZE);

	if (stale.length === 0) return 0;

	for (const row of stale) {
		await db
			.delete(rateLimit)
			.where(and(eq(rateLimit.key, row.key), eq(rateLimit.windowStart, row.windowStart)));
	}

	return stale.length;
}

interface JobResult {
	name: string;
	ok: boolean;
	/** Row count on success, error message on failure. */
	detail: number | string;
}

/**
 * Run one named job, catching so a throw in one job can't stop the rest of
 * the batch. Failures are surfaced in the returned result (and logged by
 * the caller) rather than swallowed — `worker/entry.ts`'s own top-level
 * catch only guards the whole batch, not the jobs inside it.
 */
async function runOne(name: string, fn: () => Promise<number>): Promise<JobResult> {
	try {
		return { name, ok: true, detail: await fn() };
	} catch (error) {
		return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/** One line per job, so `wrangler tail` shows what a tick actually did (§15). */
function report(kind: JobKind, results: JobResult[]): void {
	for (const result of results) {
		if (result.ok) {
			console.log(`[jobs:${kind}] ${result.name}: ${result.detail} row(s)`);
		} else {
			console.error(`[jobs:${kind}] ${result.name} failed: ${result.detail}`);
		}
	}
}

export async function runJobs(kind: JobKind, platform: App.Platform): Promise<void> {
	switch (kind) {
		case 'every-15-min': {
			const db = getDb(platform);
			const now = Date.now();

			const results = await Promise.all([
				runOne('sweep-abandoned-sessions', () => sweepAbandonedSessions(db, now)),
				runOne('purge-daily-guest-claims', () => purgeDailyGuestClaims(db, now)),
				runOne('purge-rate-limit-windows', () => purgeRateLimitWindows(db, now))
			]);

			report(kind, results);
			return;
		}
		case 'hourly': {
			const db = getDb(platform);
			// The ephemeral-quiz sweep is the only job here that deletes rows a
			// player might still be about to use, so it runs at its spec'd hourly
			// cadence (§15) rather than riding the 15-min tick.
			const results = [
				await runOne('sweep-ephemeral-quizzes', () => sweepEphemeralQuizzes(db, Date.now()))
			];

			report(kind, results);
			return;
		}
		case 'daily':
			// TODO(3.1, 3.8, 3.11, 4.2): daily-quiz publication check, weekly ladder snapshot,
			// metrics_daily aggregation, availability re-check
			return;
		default:
			kind satisfies never;
	}
}
