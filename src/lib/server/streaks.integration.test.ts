/**
 * Daily streaks — DAILY-4, §G-7, plan task 3.4.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeStreaks } from './streaks.js';
import { gameSession, importedHistory } from './db/schema.js';
import {
	createQuiz,
	createUser,
	ensureMigrations,
	resetDb,
	testDb
} from './test-utils.integration.js';
import { newId } from './ids.js';

const db = testDb();

beforeAll(async () => {
	await ensureMigrations();
});
beforeEach(async () => {
	await resetDb(db);
});

async function scoredDailyRow(userId: string, day: string, quizId: string) {
	await db.insert(gameSession).values({
		id: newId(),
		quizId,
		dailyDay: day,
		userId,
		guestId: null,
		nickname: 'Fixture',
		status: 'completed',
		scored: true,
		curveVersion: 1,
		effectiveScoringMode: 'speed',
		totalScore: 100,
		startedAt: Date.now(),
		finalizedAt: Date.now()
	});
}

describe('computeStreaks (DAILY-4)', () => {
	it('zero when nothing was ever played', async () => {
		const user = await createUser(db);
		const streaks = await computeStreaks(db, user.id, Date.parse('2026-08-10T12:00:00+02:00'));
		expect(streaks).toEqual({ current: 0, best: 0 });
	});

	it('counts a run ending today', async () => {
		const user = await createUser(db);
		const { quiz } = await createQuiz(db, { kind: 'daily' });
		await scoredDailyRow(user.id, '2026-08-08', quiz.id);
		await scoredDailyRow(user.id, '2026-08-09', quiz.id);
		await scoredDailyRow(user.id, '2026-08-10', quiz.id);

		const streaks = await computeStreaks(db, user.id, Date.parse('2026-08-10T20:00:00+02:00'));
		expect(streaks.current).toBe(3);
		expect(streaks.best).toBe(3);
	});

	it("today not yet played doesn't break the streak — counts from yesterday", async () => {
		const user = await createUser(db);
		const { quiz } = await createQuiz(db, { kind: 'daily' });
		await scoredDailyRow(user.id, '2026-08-08', quiz.id);
		await scoredDailyRow(user.id, '2026-08-09', quiz.id);

		const streaks = await computeStreaks(db, user.id, Date.parse('2026-08-10T08:00:00+02:00'));
		expect(streaks.current).toBe(2);
	});

	it('a gap in the middle keeps only the trailing run current, but best remembers the earlier one', async () => {
		const user = await createUser(db);
		const { quiz } = await createQuiz(db, { kind: 'daily' });
		await scoredDailyRow(user.id, '2026-08-01', quiz.id);
		await scoredDailyRow(user.id, '2026-08-02', quiz.id);
		await scoredDailyRow(user.id, '2026-08-03', quiz.id);
		await scoredDailyRow(user.id, '2026-08-10', quiz.id);

		// Today is 08-11; yesterday (08-10) was played, so the streak is alive
		// at length 1 — but 08-09 is a gap, so it doesn't reach further back.
		const streaks = await computeStreaks(db, user.id, Date.parse('2026-08-11T08:00:00+02:00'));
		expect(streaks.current).toBe(1);
		expect(streaks.best).toBe(3);
	});

	it('two full missed days zeroes the current streak entirely', async () => {
		const user = await createUser(db);
		const { quiz } = await createQuiz(db, { kind: 'daily' });
		await scoredDailyRow(user.id, '2026-08-01', quiz.id);
		await scoredDailyRow(user.id, '2026-08-02', quiz.id);
		await scoredDailyRow(user.id, '2026-08-03', quiz.id);

		const streaks = await computeStreaks(db, user.id, Date.parse('2026-08-11T08:00:00+02:00'));
		expect(streaks.current).toBe(0);
		expect(streaks.best).toBe(3);
	});

	it('imported history counts toward best only, never current (§G-7)', async () => {
		const user = await createUser(db);
		await db.insert(importedHistory).values({
			id: newId(),
			userId: user.id,
			quizId: null,
			quizName: 'Imported daily',
			totalScore: 50,
			rounds: 5,
			isDaily: true,
			playedAt: Date.parse('2026-08-10T10:00:00+02:00')
		});

		const streaks = await computeStreaks(db, user.id, Date.parse('2026-08-10T20:00:00+02:00'));
		expect(streaks.current).toBe(0);
		expect(streaks.best).toBe(1);
	});
});
