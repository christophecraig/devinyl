/**
 * Personal stats — STAT-1, plan task 3.9.
 *
 * Every number here is computed at read time from `game_session` (+ its
 * rounds, for the genre/decade breakdown), the same "no running counter to
 * drift" posture as `streaks.ts`. `imported_history` (ACC-4) folds into
 * games-played/average/bests — STAT-1 explicitly wants it — but never into
 * anything board-shaped, and its streak contribution is *best*-only
 * (`streaks.ts`, §G-7).
 */

import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { gameSession, importedHistory, quizTrack, roundResult, trackCache } from './db/schema.js';
import { bestWeeklyRank } from './weekly.js';
import { computeStreaks, type StreakInfo } from './streaks.js';

export interface ModeBreakdown {
	speed: number;
	fixed: number;
}

export interface PersonalStats {
	gamesPlayed: number;
	averageScore: number;
	bestScore: number;
	streaks: StreakInfo;
	modeBreakdown: ModeBreakdown;
	topGenres: { genre: string; count: number }[];
	topDecades: { decade: number; count: number }[];
	bestWeeklyRank: { week: string; rank: number } | null;
}

export async function getPersonalStats(
	db: Db,
	userId: string,
	now: number = Date.now()
): Promise<PersonalStats> {
	const [scoredSessions, importedRows, genreRows, decadeRows, streaks, weeklyRank] =
		await Promise.all([
			db
				.select({
					totalScore: gameSession.totalScore,
					effectiveScoringMode: gameSession.effectiveScoringMode
				})
				.from(gameSession)
				.where(and(eq(gameSession.userId, userId), eq(gameSession.scored, true))),
			db
				.select({ totalScore: importedHistory.totalScore })
				.from(importedHistory)
				.where(eq(importedHistory.userId, userId)),
			db
				.select({ genre: trackCache.genre, n: count() })
				.from(roundResult)
				.innerJoin(gameSession, eq(gameSession.id, roundResult.sessionId))
				.innerJoin(
					quizTrack,
					and(
						eq(quizTrack.quizId, gameSession.quizId),
						eq(quizTrack.position, roundResult.position)
					)
				)
				.innerJoin(trackCache, eq(trackCache.id, quizTrack.trackId))
				.where(
					and(
						eq(gameSession.userId, userId),
						eq(roundResult.skipped, false),
						isNotNull(trackCache.genre)
					)
				)
				.groupBy(trackCache.genre)
				.orderBy(desc(count()))
				.limit(5),
			db
				.select({ decade: trackCache.decade, n: count() })
				.from(roundResult)
				.innerJoin(gameSession, eq(gameSession.id, roundResult.sessionId))
				.innerJoin(
					quizTrack,
					and(
						eq(quizTrack.quizId, gameSession.quizId),
						eq(quizTrack.position, roundResult.position)
					)
				)
				.innerJoin(trackCache, eq(trackCache.id, quizTrack.trackId))
				.where(
					and(
						eq(gameSession.userId, userId),
						eq(roundResult.skipped, false),
						isNotNull(trackCache.decade)
					)
				)
				.groupBy(trackCache.decade)
				.orderBy(desc(count()))
				.limit(5),
			computeStreaks(db, userId, now),
			bestWeeklyRank(db, userId)
		]);

	const scores = [
		...scoredSessions.map((s) => s.totalScore ?? 0),
		...importedRows.map((r) => r.totalScore)
	];
	const gamesPlayed = scores.length;
	const averageScore =
		gamesPlayed > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / gamesPlayed) : 0;
	const bestScore = gamesPlayed > 0 ? Math.max(...scores) : 0;

	const modeBreakdown = scoredSessions.reduce<ModeBreakdown>(
		(acc, s) => {
			acc[s.effectiveScoringMode]++;
			return acc;
		},
		{ speed: 0, fixed: 0 }
	);

	return {
		gamesPlayed,
		averageScore,
		bestScore,
		streaks,
		modeBreakdown,
		topGenres: genreRows
			.filter((r): r is { genre: string; n: number } => r.genre !== null)
			.map((r) => ({ genre: r.genre, count: r.n })),
		topDecades: decadeRows
			.filter((r): r is { decade: number; n: number } => r.decade !== null)
			.map((r) => ({ decade: r.decade, count: r.n })),
		bestWeeklyRank: weeklyRank
	};
}
