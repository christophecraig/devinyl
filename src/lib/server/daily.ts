/**
 * Daily quiz — DAILY-1/2/5, technical-spec §6/§11, plan task 3.1.
 *
 * Scheduling and the calendar view already live in `admin/index.ts`
 * (task 2.9, CREATE-9); this module is the player-facing read side plus the
 * publication-gap check the daily cron job runs (§15).
 */

import { and, eq, gte, lte } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { dailyQuiz, gameSession, quiz, quizTrack } from './db/schema.js';
import { apiError } from './http.js';
import type { Player } from './identity.js';
import { parisDay, parisDayOffset } from './time.js';

export interface DailyInfo {
	day: string;
	dayNumber: number;
	quizId: string;
	rounds: number;
	/** DAILY-5: past dailies are practice-only — the client uses this to hide "beat the board" framing. */
	isToday: boolean;
	/** DAILY-2: whether *this* player already has a scored attempt for this day. */
	alreadyPlayed: boolean;
}

/**
 * `day` defaults to today (Europe/Paris); pass an earlier `YYYY-MM-DD` to
 * load a past daily as practice (DAILY-5) — 404s if that day was never
 * scheduled, and refuses days in the future so nothing gets a sneak preview.
 */
export async function getDaily(
	db: Db,
	player: Player | null,
	day?: string,
	now = Date.now()
): Promise<DailyInfo> {
	const today = parisDay(now);
	const targetDay = day ?? today;
	if (targetDay > today) apiError('not_found', 'There is no quiz for that day yet.');

	const [row] = await db.select().from(dailyQuiz).where(eq(dailyQuiz.day, targetDay)).limit(1);
	if (!row) apiError('not_found', 'There is no quiz for that day yet — check back shortly.');

	const rounds = await countDailyRounds(db, row.quizId);

	let alreadyPlayed = false;
	if (player) {
		const identity =
			player.kind === 'user'
				? eq(gameSession.userId, player.userId)
				: eq(gameSession.guestId, player.guestId);
		const [existing] = await db
			.select({ id: gameSession.id })
			.from(gameSession)
			.where(and(eq(gameSession.dailyDay, targetDay), eq(gameSession.scored, true), identity))
			.limit(1);
		alreadyPlayed = Boolean(existing);
	}

	return {
		day: row.day,
		dayNumber: row.dayNumber,
		quizId: row.quizId,
		rounds,
		isToday: targetDay === today,
		alreadyPlayed
	};
}

async function countDailyRounds(db: Db, quizId: string): Promise<number> {
	const tracks = await db
		.select({ position: quizTrack.position })
		.from(quizTrack)
		.where(eq(quizTrack.quizId, quizId));
	return tracks.length;
}

/**
 * §15 daily-cron publication check: does *tomorrow* have a scheduled quiz?
 * Logged loudly (`wrangler tail` picks it up, plan §G-17) since the operator
 * alert channel proper (email + `/admin` banner) is task 4.2 — this is the
 * detector the alert will eventually be wired to, not the alert itself.
 */
export async function checkDailyPublicationGap(
	db: Db,
	now: number
): Promise<{ day: string; ok: boolean }> {
	const tomorrow = parisDayOffset(now, 1);
	const [row] = await db
		.select({ day: dailyQuiz.day })
		.from(dailyQuiz)
		.where(eq(dailyQuiz.day, tomorrow))
		.limit(1);
	const ok = Boolean(row);
	if (!ok) {
		console.error(`[daily] gap alert: no quiz scheduled for ${tomorrow}`);
	}
	return { day: tomorrow, ok };
}

/** DAILY-5: quizzes from the last N days, for a "recent dailies" practice list. */
export async function listRecentDailies(db: Db, now: number, days = 14) {
	const from = parisDayOffset(now, -days);
	const to = parisDay(now);
	return db
		.select({
			day: dailyQuiz.day,
			dayNumber: dailyQuiz.dayNumber,
			quizId: dailyQuiz.quizId,
			quizName: quiz.name
		})
		.from(dailyQuiz)
		.innerJoin(quiz, eq(quiz.id, dailyQuiz.quizId))
		.where(and(gte(dailyQuiz.day, from), lte(dailyQuiz.day, to)))
		.orderBy(dailyQuiz.day);
}
