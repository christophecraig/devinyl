/**
 * Account deletion — ACC-6, §6/§16, plan task 2.11.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	createGameSession,
	createQuiz,
	createUser,
	ensureMigrations,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { account, friendship, gameSession, quiz, session, user, weeklyPoints } from '../db/schema.js';
import { purgeDeletedUserTombstones } from '../jobs/index.js';
import { DELETED_EMAIL_HASH_TTL_MS, deleteAccount } from './delete-account.js';

const db = testDb();
const SECRET = 'test-delete-secret';

describe('deleteAccount (task 2.11)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	it('kills every session and credential immediately', async () => {
		const victim = await createUser(db);
		await db.insert(session).values({
			id: 's1',
			userId: victim.id,
			token: 'tok-1',
			expiresAt: new Date(Date.now() + 1000)
		});
		await db.insert(account).values({
			id: 'a1',
			userId: victim.id,
			accountId: victim.email,
			providerId: 'credential',
			password: 'hashed'
		});

		await deleteAccount(db, victim.id, SECRET);

		expect(await db.select().from(session).where(eq(session.userId, victim.id))).toHaveLength(0);
		expect(await db.select().from(account).where(eq(account.userId, victim.id))).toHaveLength(0);
	});

	it('hard-deletes friendships and weekly_points', async () => {
		const victim = await createUser(db);
		const friend = await createUser(db, {
			email: 'friend@example.test',
			displayName: 'Friend',
			displayNameNormalized: 'friend'
		});
		const [a, b] = [victim.id, friend.id].sort();
		await db.insert(friendship).values({ aUserId: a, bUserId: b, status: 'accepted', requestedBy: a });
		await db.insert(weeklyPoints).values({ userId: victim.id, week: '2026-W32', points: 100 });

		await deleteAccount(db, victim.id, SECRET);

		expect(await db.select().from(friendship)).toHaveLength(0);
		expect(
			await db.select().from(weeklyPoints).where(eq(weeklyPoints.userId, victim.id))
		).toHaveLength(0);
	});

	it("anonymizes this player's own game_session rows in place, keeping the score", async () => {
		const victim = await createUser(db);
		const { quiz: quizRow } = await createQuiz(db);
		const played = await createGameSession(db, quizRow, {
			guestId: null,
			userId: victim.id,
			nickname: 'RealName',
			scored: true,
			totalScore: 777,
			status: 'completed'
		});

		await deleteAccount(db, victim.id, SECRET);

		const [row] = await db.select().from(gameSession).where(eq(gameSession.id, played.id));
		expect(row.userId).toBeNull();
		expect(row.nickname).toBe('Deleted player');
		expect(row.totalScore).toBe(777);
		expect(row.scored).toBe(true);
	});

	it('orphans owned quizzes (owner_id NULL, soft-deleted) rather than removing them', async () => {
		const victim = await createUser(db);
		const { quiz: quizRow } = await createQuiz(db, { ownerId: victim.id });

		await deleteAccount(db, victim.id, SECRET, 5000);

		const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
		expect(row.ownerId).toBeNull();
		expect(row.deletedAt).toBe(5000);
	});

	it('tombstones the user row with a keyed email hash rather than removing it', async () => {
		const victim = await createUser(db, { email: 'secret@example.test' });

		await deleteAccount(db, victim.id, SECRET, 1_000_000);

		const [row] = await db.select().from(user).where(eq(user.id, victim.id));
		expect(row).toBeDefined();
		expect(row.email).not.toBe('secret@example.test');
		expect(row.displayName).toBe('Deleted player');
		expect(row.deletedEmailHash).toBeTruthy();
		expect(row.deletedEmailHashExpiresAt).toBe(1_000_000 + DELETED_EMAIL_HASH_TTL_MS);
	});

	it('is idempotent — a retried call after success is a no-op', async () => {
		const victim = await createUser(db);
		await deleteAccount(db, victim.id, SECRET);
		await expect(deleteAccount(db, victim.id, SECRET)).resolves.toBeUndefined();
	});
});

describe('purgeDeletedUserTombstones (task 2.11 purge)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	it('removes a tombstone once its 30-day window has passed', async () => {
		const victim = await createUser(db);
		await deleteAccount(db, victim.id, SECRET, 0);

		const removed = await purgeDeletedUserTombstones(db, DELETED_EMAIL_HASH_TTL_MS + 1);
		expect(removed).toBe(1);
		expect(await db.select().from(user).where(eq(user.id, victim.id))).toHaveLength(0);
	});

	it('leaves a tombstone alone before its window passes', async () => {
		const victim = await createUser(db);
		await deleteAccount(db, victim.id, SECRET, 0);

		const removed = await purgeDeletedUserTombstones(db, DELETED_EMAIL_HASH_TTL_MS - 1);
		expect(removed).toBe(0);
		expect(await db.select().from(user).where(eq(user.id, victim.id))).toHaveLength(1);
	});

	it('never touches a live (non-deleted) user', async () => {
		const live = await createUser(db);
		const removed = await purgeDeletedUserTombstones(db, Date.now() + 100 * DELETED_EMAIL_HASH_TTL_MS);
		expect(removed).toBe(0);
		expect(await db.select().from(user).where(eq(user.id, live.id))).toHaveLength(1);
	});
});
