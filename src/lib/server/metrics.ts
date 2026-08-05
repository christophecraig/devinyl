/**
 * Metrics aggregation — MET-1/2/3, §15, plan task 3.11.
 *
 * `metrics_daily` (`day`, `metric`, `value`) is deliberately counts-only —
 * MET-3 requires measurement to stay aggregate and personal-data-free, so
 * nothing here ever writes a player id, guest id, or IP into this table.
 *
 * Two funnels can't be computed from a snapshot of `game_session` alone:
 *
 *   - **daily/challenge shares and challenge opens** have no row anywhere
 *     until `share_event` (plan §G-2) records one — the client calls
 *     `POST /api/metrics/event` (see the route) at the moment of the Share
 *     API/clipboard action or the lobby page load, and this job just copies
 *     that day's counters into `metrics_daily` for one dashboard to read.
 *   - **guest → account conversion** happens inside `me/import-guest.ts` at
 *     the exact instant it's true; back-computing "was this user recently a
 *     guest" from historical rows isn't possible once the guest id is gone,
 *     so that module increments `metrics_daily` itself, same day, same
 *     table. This job leaves that metric alone rather than overwriting it.
 */

import { and, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { gameSession, metricsDaily, shareEvent } from './db/schema.js';
import { computeStreaks } from './streaks.js';
import { parisDayRangeMs, shiftParisDay } from './time.js';

async function upsertMetric(db: Db, day: string, metric: string, value: number): Promise<void> {
	await db
		.insert(metricsDaily)
		.values({ day, metric, value })
		.onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.metric], set: { value } });
}

async function countSessions(
	db: Db,
	startMs: number,
	endMs: number,
	extra: SQL[]
): Promise<number> {
	const rows = await db
		.select({ id: gameSession.id })
		.from(gameSession)
		.where(and(gte(gameSession.startedAt, startMs), lt(gameSession.startedAt, endMs), ...extra));
	return rows.length;
}

async function shareEventValue(
	db: Db,
	day: string,
	kind: (typeof shareEvent.$inferSelect)['kind']
): Promise<number> {
	const [row] = await db
		.select({ count: shareEvent.count })
		.from(shareEvent)
		.where(and(eq(shareEvent.day, day), eq(shareEvent.kind, kind)))
		.limit(1);
	return row?.count ?? 0;
}

/** Distinct registered players with a *scored* daily attempt on `day` — the D1/D7 cohort base. */
async function dailyScoredUserIds(db: Db, day: string): Promise<Set<string>> {
	const rows = await db
		.select({ userId: gameSession.userId })
		.from(gameSession)
		.where(
			and(
				eq(gameSession.dailyDay, day),
				eq(gameSession.scored, true),
				isNotNull(gameSession.userId)
			)
		);
	return new Set(rows.map((r) => r.userId as string));
}

/** MET-1: D1/D7 return among players who completed a daily `lagDays` earlier. */
async function returnRate(
	db: Db,
	day: string,
	lagDays: number
): Promise<{ cohort: number; returned: number }> {
	const baseDay = shiftParisDay(day, -lagDays);
	const base = await dailyScoredUserIds(db, baseDay);
	if (base.size === 0) return { cohort: 0, returned: 0 };
	const today = await dailyScoredUserIds(db, day);
	let returned = 0;
	for (const id of base) if (today.has(id)) returned++;
	return { cohort: base.size, returned };
}

const STREAK_BUCKETS = ['0', '1', '2', '3', '4', '5plus'] as const;

function streakBucket(current: number): (typeof STREAK_BUCKETS)[number] {
	return current >= 5 ? '5plus' : (String(current) as (typeof STREAK_BUCKETS)[number]);
}

/** MET-1's streak-length distribution among players who played the daily on `day`. */
async function streakHistogram(db: Db, day: string, now: number): Promise<Record<string, number>> {
	const userIds = await dailyScoredUserIds(db, day);
	const counts: Record<string, number> = Object.fromEntries(STREAK_BUCKETS.map((b) => [b, 0]));
	for (const userId of userIds) {
		const { current } = await computeStreaks(db, userId, now);
		counts[streakBucket(current)]++;
	}
	return counts;
}

/**
 * Aggregates `day` (normally "yesterday", called from the daily cron once
 * that day is fully over) into `metrics_daily`. Idempotent — re-running for
 * the same day overwrites with the same numbers, so a retried tick is safe.
 */
export async function aggregateMetricsDaily(
	db: Db,
	day: string,
	now: number = Date.now()
): Promise<void> {
	const { startMs, endMs } = parisDayRangeMs(day);

	const dailyStarted = await countSessions(db, startMs, endMs, [isNotNull(gameSession.dailyDay)]);
	const dailyCompleted = await countSessions(db, startMs, endMs, [
		isNotNull(gameSession.dailyDay),
		eq(gameSession.status, 'completed')
	]);
	const challengeStarted = await countSessions(db, startMs, endMs, [
		isNotNull(gameSession.challengeToken)
	]);
	const challengeCompleted = await countSessions(db, startMs, endMs, [
		isNotNull(gameSession.challengeToken),
		eq(gameSession.status, 'completed')
	]);

	const dailyShared = await shareEventValue(db, day, 'daily_share');
	const challengeOpened = await shareEventValue(db, day, 'challenge_open');
	const quizOpened = await shareEventValue(db, day, 'quiz_open');
	const inviteOpened = await shareEventValue(db, day, 'invite_open');

	const d1 = await returnRate(db, day, 1);
	const d7 = await returnRate(db, day, 7);

	const streaks = await streakHistogram(db, day, now);

	await Promise.all([
		upsertMetric(db, day, 'daily_started', dailyStarted),
		upsertMetric(db, day, 'daily_completed', dailyCompleted),
		upsertMetric(db, day, 'daily_shared', dailyShared),
		upsertMetric(db, day, 'challenge_opened', challengeOpened),
		upsertMetric(db, day, 'challenge_started', challengeStarted),
		upsertMetric(db, day, 'challenge_completed', challengeCompleted),
		upsertMetric(db, day, 'quiz_opened', quizOpened),
		upsertMetric(db, day, 'invite_opened', inviteOpened),
		upsertMetric(db, day, 'd1_cohort', d1.cohort),
		upsertMetric(db, day, 'd1_return', d1.returned),
		upsertMetric(db, day, 'd7_cohort', d7.cohort),
		upsertMetric(db, day, 'd7_return', d7.returned),
		...STREAK_BUCKETS.map((b) => upsertMetric(db, day, `streak_${b}`, streaks[b]))
	]);
}

/** MET-1: bump an anonymous share/open counter (plan §G-2) — no identity, ever. */
export async function recordShareEvent(
	db: Db,
	day: string,
	kind: (typeof shareEvent.$inferSelect)['kind']
): Promise<void> {
	await db
		.insert(shareEvent)
		.values({ day, kind, count: 1 })
		.onConflictDoUpdate({
			target: [shareEvent.day, shareEvent.kind],
			set: { count: sql`${shareEvent.count} + 1` }
		});
}
