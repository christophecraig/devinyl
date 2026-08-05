/**
 * Weekly ladder reads — STAT-4, §11, plan task 3.8.
 *
 * The write side (`weekly_points` upsert at finalize, the ×2 daily / 100-point
 * scale formula) already lives in `sessions/finalize.ts`
 * (`weeklyContribution`, `creditWeeklyLadder`) — this module is the read
 * side: the current week's board, and the Monday-00:05 best-rank snapshot
 * the daily cron runs before the old week's `weekly_points` rows go cold.
 */

import { desc, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { user, weeklyPoints, weeklyRankSnapshot } from './db/schema.js';
import { parisIsoWeek } from './time.js';

export interface WeeklyBoardEntry {
	rank: number;
	userId: string;
	name: string;
	points: number;
	isSelf: boolean;
}

export async function getWeeklyBoard(
	db: Db,
	opts: { week?: string; now?: number; userId?: string | null; limit?: number }
): Promise<{ week: string; entries: WeeklyBoardEntry[] }> {
	const week = opts.week ?? parisIsoWeek(opts.now ?? Date.now());
	const rows = await db
		.select({ userId: weeklyPoints.userId, points: weeklyPoints.points, name: user.displayName })
		.from(weeklyPoints)
		.innerJoin(user, eq(user.id, weeklyPoints.userId))
		.where(eq(weeklyPoints.week, week))
		.orderBy(desc(weeklyPoints.points))
		.limit(opts.limit ?? 50);

	const entries = rows.map((row, i) => ({
		rank: i + 1,
		userId: row.userId,
		name: row.name,
		points: row.points,
		isSelf: row.userId === opts.userId
	}));

	return { week, entries };
}

/** STAT-4: "past weekly results are kept in personal stats (best weekly rank)". */
export async function bestWeeklyRank(
	db: Db,
	userId: string
): Promise<{ week: string; rank: number } | null> {
	const [row] = await db
		.select({ week: weeklyRankSnapshot.week, rank: weeklyRankSnapshot.rank })
		.from(weeklyRankSnapshot)
		.where(eq(weeklyRankSnapshot.userId, userId))
		.orderBy(weeklyRankSnapshot.rank)
		.limit(1);
	return row ?? null;
}

/**
 * §11: "Monday-00:05 best-rank snapshot" — ranks every player who scored in
 * the week that just ended and records their rank into
 * `weekly_rank_snapshot`, once, before `weekly_points` for that week stops
 * changing. Ties are broken by `userId` for a deterministic (if arbitrary)
 * rank rather than a shared one — good enough for a "your best rank ever"
 * stat, which doesn't need competition-ranking's tie semantics.
 *
 * Idempotent: re-running for a week that already has snapshot rows
 * overwrites them with the same values (`onConflictDoUpdate`), so a retried
 * cron tick can't double-count or diverge.
 */
export async function snapshotWeeklyRanks(db: Db, now: number): Promise<number> {
	const currentWeek = parisIsoWeek(now);
	// The job runs at 00:05 Monday; a day back in real time lands in the week
	// that just ended. Guard against a mistimed/manual run landing on the same
	// week it would snapshot — that would record an in-progress week as final.
	const previousWeek = parisIsoWeek(now - 24 * 60 * 60 * 1000);
	if (previousWeek === currentWeek) return 0;

	const rows = await db
		.select({ userId: weeklyPoints.userId, points: weeklyPoints.points })
		.from(weeklyPoints)
		.where(eq(weeklyPoints.week, previousWeek))
		.orderBy(desc(weeklyPoints.points), weeklyPoints.userId);

	if (rows.length === 0) return 0;

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		await db
			.insert(weeklyRankSnapshot)
			.values({ userId: row.userId, week: previousWeek, rank: i + 1, points: row.points })
			.onConflictDoUpdate({
				target: [weeklyRankSnapshot.userId, weeklyRankSnapshot.week],
				set: { rank: i + 1, points: row.points }
			});
	}

	return rows.length;
}
