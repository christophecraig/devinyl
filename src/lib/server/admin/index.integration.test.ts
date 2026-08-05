/**
 * Operator tools — CREATE-8/9, SHARE-3, plan task 2.9.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGameSession, createQuiz, ensureMigrations, resetDb, testDb } from '../test-utils.integration.js';
import { dailyQuiz, quiz } from '../db/schema.js';
import {
	getDailyCalendar,
	listFlaggedSessions,
	listOfficialQuizzes,
	publishOfficial,
	scheduleDaily
} from './index.js';

const db = testDb();

describe('publishOfficial (CREATE-8/LOC-3)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});
	beforeEach(async () => {
		await resetDb(db);
	});

	it('sets kind official, clears ownerId, stores localized name/description', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'manual' });

		await publishOfficial(db, quizRow.id, {
			nameFr: 'Nom français',
			nameEn: 'English name',
			descriptionFr: 'Description FR',
			descriptionEn: null
		});

		const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
		expect(row.kind).toBe('official');
		expect(row.ownerId).toBeNull();
		expect(row.nameFr).toBe('Nom français');
		expect(row.nameEn).toBe('English name');
		expect(row.descriptionFr).toBe('Description FR');
	});

	it('appears in listOfficialQuizzes once published', async () => {
		const { quiz: quizRow } = await createQuiz(db);
		await publishOfficial(db, quizRow.id, { nameFr: 'A', nameEn: 'B' });

		const rows = await listOfficialQuizzes(db);
		expect(rows.map((r) => r.id)).toContain(quizRow.id);
	});
});

describe('daily calendar (CREATE-9)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});
	beforeEach(async () => {
		await resetDb(db);
	});

	it('schedules a day, bumping dayNumber, and flips the quiz to kind daily', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'official' });

		await scheduleDaily(db, '2026-08-10', quizRow.id);

		const [row] = await db.select().from(dailyQuiz).where(eq(dailyQuiz.day, '2026-08-10'));
		expect(row.quizId).toBe(quizRow.id);
		expect(row.dayNumber).toBe(1);

		const [quizRowAfter] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
		expect(quizRowAfter.kind).toBe('daily');
	});

	it('refuses to double-book a day', async () => {
		const { quiz: quizA } = await createQuiz(db, { kind: 'official', name: 'A' });
		const { quiz: quizB } = await createQuiz(db, { kind: 'official', name: 'B' });
		await scheduleDaily(db, '2026-08-10', quizA.id);

		await expect(scheduleDaily(db, '2026-08-10', quizB.id)).rejects.toThrow();
	});

	it('refuses to schedule a non-official quiz', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'manual' });
		await expect(scheduleDaily(db, '2026-08-10', quizRow.id)).rejects.toThrow();
	});

	it('getDailyCalendar marks unscheduled days as gaps', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'official' });
		const now = Date.parse('2026-08-05T10:00:00Z');
		await scheduleDaily(db, '2026-08-06', quizRow.id);

		const calendar = await getDailyCalendar(db, { now, lookaheadDays: 3 });

		expect(calendar).toHaveLength(4); // today + 3
		expect(calendar[0].day).toBe('2026-08-05');
		expect(calendar[0].quizId).toBeNull(); // gap
		expect(calendar[1].day).toBe('2026-08-06');
		expect(calendar[1].quizId).toBe(quizRow.id);
	});
});

describe('listFlaggedSessions (§15 /admin view)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});
	beforeEach(async () => {
		await resetDb(db);
	});

	it('lists completed sessions with a non-null scoredBlockReason, most recent first', async () => {
		const { quiz: quizRow } = await createQuiz(db);
		await createGameSession(db, quizRow, {
			status: 'completed',
			scored: false,
			scoredBlockReason: 'implausible',
			finalizedAt: 1000,
			nickname: 'Flagged1'
		});
		await createGameSession(db, quizRow, {
			status: 'completed',
			scored: true,
			scoredBlockReason: null,
			finalizedAt: 2000,
			nickname: 'CleanRun'
		});
		await createGameSession(db, quizRow, {
			status: 'completed',
			scored: false,
			scoredBlockReason: 'unverified_timing',
			finalizedAt: 3000,
			nickname: 'Flagged2'
		});

		const flagged = await listFlaggedSessions(db);
		expect(flagged.map((s) => s.nickname)).toEqual(['Flagged2', 'Flagged1']);
	});
});
