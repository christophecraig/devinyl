/**
 * Weekly ladder — STAT-4, §11, plan task 3.8.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bestWeeklyRank, getWeeklyBoard, snapshotWeeklyRanks } from './weekly.js';
import { weeklyPoints, weeklyRankSnapshot } from './db/schema.js';
import { createUser, ensureMigrations, resetDb, testDb } from './test-utils.integration.js';

const db = testDb();

beforeAll(async () => {
	await ensureMigrations();
});
beforeEach(async () => {
	await resetDb(db);
});

describe('getWeeklyBoard', () => {
	it('orders by points desc and flags isSelf', async () => {
		const a = await createUser(db, { displayName: 'Alice', displayNameNormalized: 'alice' });
		const b = await createUser(db, { displayName: 'Bob', displayNameNormalized: 'bob' });
		await db.insert(weeklyPoints).values({ userId: a.id, week: '2026-W32', points: 150 });
		await db.insert(weeklyPoints).values({ userId: b.id, week: '2026-W32', points: 200 });

		const { entries } = await getWeeklyBoard(db, { week: '2026-W32', userId: a.id });
		expect(entries.map((e) => e.name)).toEqual(['Bob', 'Alice']);
		expect(entries.find((e) => e.name === 'Alice')?.isSelf).toBe(true);
		expect(entries.find((e) => e.name === 'Bob')?.isSelf).toBe(false);
	});
});

describe('snapshotWeeklyRanks (Monday 00:05 snapshot)', () => {
	it("no-ops when 'now' is still inside the same week as the points being ranked", async () => {
		const user = await createUser(db);
		await db.insert(weeklyPoints).values({ userId: user.id, week: '2026-W32', points: 100 });

		// A run mid-week — same ISO week as the points — must not snapshot yet.
		const midWeek = Date.parse('2026-08-06T12:00:00+02:00'); // Thursday of W32
		const count = await snapshotWeeklyRanks(db, midWeek);
		expect(count).toBe(0);
	});

	it('ranks the previous week once a new week has started, and is idempotent on retry', async () => {
		const a = await createUser(db, { displayName: 'Alice', displayNameNormalized: 'alice' });
		const b = await createUser(db, { displayName: 'Bob', displayNameNormalized: 'bob' });
		await db.insert(weeklyPoints).values({ userId: a.id, week: '2026-W32', points: 300 });
		await db.insert(weeklyPoints).values({ userId: b.id, week: '2026-W32', points: 100 });

		// Monday 00:05 of the *next* ISO week (W33).
		const mondaySnapshot = Date.parse('2026-08-10T00:05:00+02:00');
		const count = await snapshotWeeklyRanks(db, mondaySnapshot);
		expect(count).toBe(2);

		const [rankA] = await bestWeeklyRankRows(a.id);
		const [rankB] = await bestWeeklyRankRows(b.id);
		expect(rankA.rank).toBe(1);
		expect(rankB.rank).toBe(2);

		// Retried tick overwrites with the same values rather than duplicating rows.
		const retried = await snapshotWeeklyRanks(db, mondaySnapshot + 1_000);
		expect(retried).toBe(2);
		const rowsAfter = await db.select().from(weeklyRankSnapshot);
		expect(rowsAfter).toHaveLength(2);
	});

	async function bestWeeklyRankRows(userId: string) {
		return db.select().from(weeklyRankSnapshot).where(eq(weeklyRankSnapshot.userId, userId));
	}
});

describe('bestWeeklyRank', () => {
	it('reads the best (lowest-numbered) snapshot for a user', async () => {
		const user = await createUser(db);
		await db
			.insert(weeklyRankSnapshot)
			.values({ userId: user.id, week: '2026-W30', rank: 5, points: 100 });
		await db
			.insert(weeklyRankSnapshot)
			.values({ userId: user.id, week: '2026-W31', rank: 2, points: 300 });

		const best = await bestWeeklyRank(db, user.id);
		expect(best).toEqual({ week: '2026-W31', rank: 2 });
	});

	it('null when the user has no snapshot', async () => {
		const user = await createUser(db);
		expect(await bestWeeklyRank(db, user.id)).toBeNull();
	});
});
