/**
 * Daily streaks — DAILY-4, plan task 3.4, §G-7.
 *
 * Computed at read time from scored daily sessions, not maintained as a
 * running counter — there is no `streak` column to keep in sync, so a missed
 * update can never drift from the truth. `imported_history`'s local-only
 * rows (ACC-4) count toward `best` only, never `current`: an imported run
 * has no server-verified date-of-play integrity, so it must not let a player
 * claim they're "on a streak" today from data nobody server-side witnessed
 * (§G-7).
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { gameSession, importedHistory } from './db/schema.js';
import { parisDay, shiftParisDay } from './time.js';

export interface StreakInfo {
	current: number;
	best: number;
}

/** Longest run of consecutive calendar days in an unordered set of `YYYY-MM-DD` keys. */
function longestRun(days: Set<string>): number {
	if (days.size === 0) return 0;
	const sorted = [...days].sort();
	let best = 1;
	let run = 1;
	for (let i = 1; i < sorted.length; i++) {
		run = sorted[i] === shiftParisDay(sorted[i - 1], 1) ? run + 1 : 1;
		best = Math.max(best, run);
	}
	return best;
}

/**
 * The run ending at today, or at yesterday if today hasn't been played yet
 * (the day isn't over — a streak isn't broken until a day is missed
 * entirely). Zero once a full day has passed with no play.
 */
function currentRun(days: Set<string>, now: number): number {
	let cursor = parisDay(now);
	if (!days.has(cursor)) {
		cursor = shiftParisDay(cursor, -1);
		if (!days.has(cursor)) return 0;
	}
	let run = 0;
	while (days.has(cursor)) {
		run++;
		cursor = shiftParisDay(cursor, -1);
	}
	return run;
}

export async function computeStreaks(
	db: Db,
	userId: string,
	now: number = Date.now()
): Promise<StreakInfo> {
	const realRows = await db
		.select({ day: gameSession.dailyDay })
		.from(gameSession)
		.where(
			and(
				eq(gameSession.userId, userId),
				eq(gameSession.scored, true),
				isNotNull(gameSession.dailyDay)
			)
		);
	const importedRows = await db
		.select({ playedAt: importedHistory.playedAt })
		.from(importedHistory)
		.where(and(eq(importedHistory.userId, userId), eq(importedHistory.isDaily, true)));

	const realDays = new Set(realRows.map((r) => r.day as string));
	const allDays = new Set(realDays);
	for (const row of importedRows) allDays.add(parisDay(row.playedAt));

	return {
		current: currentRun(realDays, now),
		best: Math.max(longestRun(allDays), currentRun(realDays, now))
	};
}
