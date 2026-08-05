/**
 * `GET /api/me/export` — LEGAL-4, §16, plan task 4.4.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { env } from 'cloudflare:test';
import {
	createGameSession,
	createQuiz,
	createRoundResult,
	createUser,
	ensureMigrations,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { account, friendship, quiz, weeklyPoints, weeklyRankSnapshot } from '../db/schema.js';
import { exportUserData } from './export.js';
import { GET } from '../../../routes/api/me/export/+server.js';

const db = testDb();

describe('exportUserData (task 4.4)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	it('includes profile fields but never a password/session secret', async () => {
		const victim = await createUser(db, {
			email: 'victim@example.test',
			birthYear: 1990,
			avatarUrl: 'https://example.test/avatar.png'
		});
		await db.insert(account).values({
			id: 'a1',
			userId: victim.id,
			accountId: victim.email,
			providerId: 'credential',
			password: 'super-secret-hash'
		});

		const dump = await exportUserData(db, victim.id, 42_000);

		expect(dump.profile.email).toBe('victim@example.test');
		expect(dump.profile.birthYear).toBe(1990);
		expect(dump.profile.avatarUrl).toBe('https://example.test/avatar.png');
		expect(dump.exportedAt).toBe(42_000);
		expect(dump.linkedAuthProviders).toEqual(['credential']);
		expect(JSON.stringify(dump)).not.toContain('super-secret-hash');
	});

	it('includes owned quizzes, both live and soft-deleted', async () => {
		const victim = await createUser(db);
		const { quiz: live } = await createQuiz(db, { ownerId: victim.id, name: 'Live quiz' });
		const { quiz: deleted } = await createQuiz(db, { ownerId: victim.id, name: 'Deleted quiz' });
		await db.update(quiz).set({ deletedAt: 1000 }).where(eq(quiz.id, deleted.id));

		const dump = await exportUserData(db, victim.id);

		const names = dump.ownedQuizzes.map((q) => q.name).sort();
		expect(names).toEqual(['Deleted quiz', 'Live quiz']);
		const deletedRow = dump.ownedQuizzes.find((q) => q.id === deleted.id);
		expect(deletedRow?.deletedAt).toBe(1000);
		const liveRow = dump.ownedQuizzes.find((q) => q.id === live.id);
		expect(liveRow?.deletedAt).toBeNull();
	});

	it('includes played sessions with their round results, ordered by position', async () => {
		const victim = await createUser(db);
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 2 });
		const played = await createGameSession(db, quizRow, {
			userId: victim.id,
			guestId: null,
			nickname: 'Victim',
			scored: true,
			totalScore: 500,
			status: 'completed'
		});
		await createRoundResult(db, played, 1, { points: 200, titleOk: true });
		await createRoundResult(db, played, 0, { points: 300, titleOk: true, artistOk: true });

		const dump = await exportUserData(db, victim.id);

		expect(dump.gameSessions).toHaveLength(1);
		const [session] = dump.gameSessions;
		expect(session.totalScore).toBe(500);
		expect(session.rounds.map((r) => r.position)).toEqual([0, 1]);
		expect(session.rounds[0].points).toBe(300);
	});

	it('includes weekly points/rank snapshots, friendships, and imported history', async () => {
		const victim = await createUser(db);
		const friend = await createUser(db, {
			email: 'friend@example.test',
			displayName: 'Friend Name',
			displayNameNormalized: 'friend name'
		});
		const [a, b] = [victim.id, friend.id].sort();
		await db
			.insert(friendship)
			.values({ aUserId: a, bUserId: b, status: 'accepted', requestedBy: victim.id });
		await db.insert(weeklyPoints).values({ userId: victim.id, week: '2026-W32', points: 150 });
		await db
			.insert(weeklyRankSnapshot)
			.values({ userId: victim.id, week: '2026-W31', rank: 3, points: 120 });

		const dump = await exportUserData(db, victim.id);

		expect(dump.weeklyPoints).toEqual([{ week: '2026-W32', points: 150 }]);
		expect(dump.weeklyRankSnapshots).toEqual([{ week: '2026-W31', rank: 3, points: 120 }]);
		expect(dump.friendships).toEqual([
			{
				friendUserId: friend.id,
				friendDisplayName: 'Friend Name',
				status: 'accepted',
				requestedByMe: true
			}
		]);
	});

	it("never leaks another user's sessions, quizzes, or friendships", async () => {
		const victim = await createUser(db);
		const other = await createUser(db, {
			email: 'other@example.test',
			displayName: 'Other',
			displayNameNormalized: 'other'
		});
		const { quiz: otherQuiz } = await createQuiz(db, { ownerId: other.id, name: "Other's quiz" });
		const otherSession = await createGameSession(db, otherQuiz, {
			userId: other.id,
			guestId: null,
			nickname: 'Other',
			scored: true,
			totalScore: 999,
			status: 'completed'
		});
		await createRoundResult(db, otherSession, 0, { points: 999 });
		await db.insert(weeklyPoints).values({ userId: other.id, week: '2026-W32', points: 999 });

		const dump = await exportUserData(db, victim.id);

		expect(dump.ownedQuizzes).toHaveLength(0);
		expect(dump.gameSessions).toHaveLength(0);
		expect(dump.weeklyPoints).toHaveLength(0);
		expect(JSON.stringify(dump)).not.toContain('999');
		expect(JSON.stringify(dump)).not.toContain("Other's quiz");
	});
});

describe('GET /api/me/export (task 4.4)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	it('401s an unauthenticated request', async () => {
		try {
			await GET({
				locals: {},
				platform: { env }
			} as unknown as Parameters<typeof GET>[0]);
			expect.unreachable('requireUserId should have thrown');
		} catch (err) {
			expect(isHttpError(err)).toBe(true);
			if (isHttpError(err)) expect(err.status).toBe(401);
		}
	});

	it('200s and returns a download for a signed-in user', async () => {
		const victim = await createUser(db);

		const response = await GET({
			locals: { userId: victim.id },
			platform: { env }
		} as unknown as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toContain('devinyl-export.json');
		const body = (await response.json()) as { profile: { email: string } };
		expect(body.profile.email).toBe(victim.email);
	});
});
