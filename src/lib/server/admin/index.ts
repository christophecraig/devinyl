/**
 * Operator tools — technical-spec §15, plan task 2.9. Every export here is
 * called only from an operator-gated route (`requireOperator`, identity.ts);
 * nothing in this module re-checks the role itself.
 */

import { and, desc, eq, gt, gte, isNotNull, isNull, lt } from 'drizzle-orm';
import type { PublishOfficialBody } from '$lib/game/schemas.js';
import type { Db } from '../db/index.js';
import { dailyQuiz, gameSession, quiz, trackCache } from '../db/schema.js';
import { apiError } from '../http.js';
import { parisDayOffset } from '../time.js';

// ---------------------------------------------------------------------------
// CREATE-8 — publish as official
// ---------------------------------------------------------------------------

/**
 * Promotes an existing (manual or generated) quiz to `kind: 'official'`:
 * ownerless (§6 — NULL means operator-owned for official/daily) and carrying
 * the localized name/description LOC-3 needs. The track list is untouched —
 * publishing is a curation step, not a re-assembly.
 */
export async function publishOfficial(
	db: Db,
	quizId: string,
	body: PublishOfficialBody,
	now: number = Date.now()
): Promise<void> {
	const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!row || row.deletedAt !== null) apiError('not_found', 'That quiz could not be found.');
	if (row.kind === 'daily') {
		apiError(
			'bad_request',
			'This quiz is already scheduled as a daily — publish it as official first.'
		);
	}

	await db
		.update(quiz)
		.set({
			kind: 'official',
			ownerId: null,
			name: body.nameEn,
			nameFr: body.nameFr,
			nameEn: body.nameEn,
			descriptionFr: body.descriptionFr ?? null,
			descriptionEn: body.descriptionEn ?? null,
			updatedAt: now
		})
		.where(eq(quiz.id, quizId));
}

// ---------------------------------------------------------------------------
// SHARE-3 — official catalog browse
// ---------------------------------------------------------------------------

export async function listOfficialQuizzes(db: Db) {
	return db
		.select()
		.from(quiz)
		.where(and(eq(quiz.kind, 'official'), isNull(quiz.deletedAt)))
		.orderBy(desc(quiz.updatedAt));
}

// ---------------------------------------------------------------------------
// CREATE-9 — daily calendar
// ---------------------------------------------------------------------------

export async function scheduleDaily(db: Db, day: string, quizId: string): Promise<void> {
	const [quizRow] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!quizRow || quizRow.deletedAt !== null)
		apiError('not_found', 'That quiz could not be found.');
	if (quizRow.kind !== 'official' && quizRow.kind !== 'daily') {
		apiError(
			'bad_request',
			'Only an official quiz can be scheduled as a daily — publish it first.'
		);
	}

	const [existing] = await db.select().from(dailyQuiz).where(eq(dailyQuiz.day, day)).limit(1);
	if (existing) apiError('conflict', `${day} is already scheduled.`);

	const [latest] = await db
		.select({ dayNumber: dailyQuiz.dayNumber })
		.from(dailyQuiz)
		.orderBy(desc(dailyQuiz.dayNumber))
		.limit(1);
	const dayNumber = (latest?.dayNumber ?? 0) + 1;

	await db.insert(dailyQuiz).values({ day, quizId, dayNumber });
	if (quizRow.kind !== 'daily') {
		await db.update(quiz).set({ kind: 'daily' }).where(eq(quiz.id, quizId));
	}
}

export interface DailyCalendarEntry {
	day: string;
	quizId: string | null;
	quizName: string | null;
	dayNumber: number | null;
}

/**
 * Today plus the next `lookaheadDays` (default 14, matching the launch
 * checklist's "≥ 14 days pre-scheduled" bar, task 4.14) — every day gets a
 * row, `quizId: null` marking a gap so the operator sees exactly which days
 * still need a pick rather than having to diff two lists themselves.
 */
export async function getDailyCalendar(
	db: Db,
	opts: { now?: number; lookaheadDays?: number } = {}
): Promise<DailyCalendarEntry[]> {
	const now = opts.now ?? Date.now();
	const lookaheadDays = opts.lookaheadDays ?? 14;

	// Half-open [today, today + lookaheadDays] — string comparison is exact
	// for YYYY-MM-DD's fixed-width, zero-padded format.
	const toDay = parisDayOffset(now, lookaheadDays);

	const scheduled = await db
		.select({
			day: dailyQuiz.day,
			quizId: dailyQuiz.quizId,
			dayNumber: dailyQuiz.dayNumber,
			quizName: quiz.name
		})
		.from(dailyQuiz)
		.innerJoin(quiz, eq(quiz.id, dailyQuiz.quizId))
		.where(and(gt(dailyQuiz.day, parisDayOffset(now, -1)), lt(dailyQuiz.day, toDay)));
	const byDay = new Map(scheduled.map((row) => [row.day, row]));

	const calendar: DailyCalendarEntry[] = [];
	for (let offset = 0; offset <= lookaheadDays; offset++) {
		const day = parisDayOffset(now, offset);
		const found = byDay.get(day);
		calendar.push(found ?? { day, quizId: null, quizName: null, dayNumber: null });
	}
	return calendar;
}

// ---------------------------------------------------------------------------
// Availability incidents (§5.3 / §G-5 — the `/admin` half of the operator alert)
// ---------------------------------------------------------------------------

export interface AvailabilityIncidents {
	/** Tracks the re-check job stamped `unavailable_at` on inside the window, newest first. */
	tracks: { id: string; title: string; unavailableAt: number }[];
	/** Upcoming daily days with no quiz — including any slot the job just disqualified. */
	emptyUpcomingDays: string[];
}

/**
 * The `/admin` availability banner's data, **derived entirely from columns that
 * already exist** (task 4.2 rules out a migration): `track_cache.unavailable_at`
 * for the takedowns, and the gaps `getDailyCalendar` already computes for the
 * disqualified slots.
 *
 * That derivation is what makes the banner correct without an incident table:
 * clearing a daily slot *is* creating a gap, and stamping `unavailable_at` *is*
 * recording a takedown — so the banner reads the effects rather than a
 * parallel log that could drift from them. The cost is that the banner can't
 * distinguish "the job disqualified this day" from "the operator never
 * scheduled it", which is the same thing to whoever has to fix it.
 */
export async function listAvailabilityIncidents(
	db: Db,
	opts: { now?: number; windowDays?: number; lookaheadDays?: number; limit?: number } = {}
): Promise<AvailabilityIncidents> {
	const now = opts.now ?? Date.now();
	const windowDays = opts.windowDays ?? 14;
	const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

	const tracks = await db
		.select({
			id: trackCache.id,
			title: trackCache.title,
			unavailableAt: trackCache.unavailableAt
		})
		.from(trackCache)
		.where(and(isNotNull(trackCache.unavailableAt), gte(trackCache.unavailableAt, cutoff)))
		.orderBy(desc(trackCache.unavailableAt))
		.limit(opts.limit ?? 50);

	const calendar = await getDailyCalendar(db, { now, lookaheadDays: opts.lookaheadDays });

	return {
		// `unavailableAt` is nullable in the column type but never null here — the
		// `isNotNull` filter above is what guarantees it.
		tracks: tracks.map((t) => ({ ...t, unavailableAt: t.unavailableAt as number })),
		emptyUpcomingDays: calendar.filter((entry) => entry.quizId === null).map((entry) => entry.day)
	};
}

// ---------------------------------------------------------------------------
// Flagged sessions (§15 /admin view)
// ---------------------------------------------------------------------------

export interface FlaggedSession {
	id: string;
	quizId: string;
	quizName: string;
	nickname: string;
	scoredBlockReason: string;
	finalizedAt: number | null;
}

/** Every completed-but-unscored session, most recent first — the operator's "what needs a look" queue. */
export async function listFlaggedSessions(db: Db, limit = 100): Promise<FlaggedSession[]> {
	const rows = await db
		.select({
			id: gameSession.id,
			quizId: gameSession.quizId,
			quizName: quiz.name,
			nickname: gameSession.nickname,
			scoredBlockReason: gameSession.scoredBlockReason,
			finalizedAt: gameSession.finalizedAt
		})
		.from(gameSession)
		.innerJoin(quiz, eq(quiz.id, gameSession.quizId))
		.where(and(isNotNull(gameSession.scoredBlockReason), eq(gameSession.status, 'completed')))
		.orderBy(desc(gameSession.finalizedAt))
		.limit(limit);

	return rows as FlaggedSession[];
}
