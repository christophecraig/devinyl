/**
 * `importGuest` — technical-spec §10, plan task 2.5 (ACC-4).
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
import { gameSession, importedHistory, weeklyPoints } from '../db/schema.js';
import { importGuest } from './import-guest.js';

const db = testDb();

describe('importGuest (task 2.5)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	it('re-attributes every game_session row carrying the old guest id', async () => {
		const owner = await createUser(db, {
			email: 'owner@example.test',
			displayName: 'Owner',
			displayNameNormalized: 'owner'
		});
		const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id });
		const session = await createGameSession(db, quizRow, { guestId: 'guest-abc' });

		const player = await createUser(db, {
			email: 'player@example.test',
			displayName: 'Player',
			displayNameNormalized: 'player'
		});
		await importGuest(db, player.id, { guestId: 'guest-abc', history: [] });

		const [row] = await db.select().from(gameSession).where(eq(gameSession.id, session.id));
		expect(row.userId).toBe(player.id);
		expect(row.guestId).toBeNull();
	});

	it('demotes the later of two now-colliding scored runs to replay (FAIR-2)', async () => {
		const { quiz: quizRow } = await createQuiz(db);
		const player = await createUser(db);

		// Already the account's own — finalized first.
		await createGameSession(db, quizRow, {
			guestId: null,
			userId: player.id,
			scored: true,
			totalScore: 500,
			finalizedAt: 1000,
			status: 'completed'
		});
		// Played as a guest, later, before signing up.
		const guestSession = await createGameSession(db, quizRow, {
			guestId: 'guest-xyz',
			scored: true,
			totalScore: 800,
			finalizedAt: 2000,
			status: 'completed'
		});

		const result = await importGuest(db, player.id, { guestId: 'guest-xyz', history: [] });
		expect(result.demotedToReplay).toBe(1);

		const [reattributed] = await db
			.select()
			.from(gameSession)
			.where(eq(gameSession.id, guestSession.id));
		expect(reattributed.scored).toBe(false);
		expect(reattributed.scoredBlockReason).toBe('replay');
	});

	it('backfills weekly_points for a re-attributed daily session, additively', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'daily', trackCount: 2 });
		const player = await createUser(db);

		await createGameSession(db, quizRow, {
			guestId: 'guest-daily',
			dailyDay: '2026-08-03',
			scored: true,
			totalScore: 1000,
			finalizedAt: Date.parse('2026-08-03T10:00:00Z'),
			status: 'completed',
			effectiveScoringMode: 'speed'
		});

		await importGuest(db, player.id, { guestId: 'guest-daily', history: [] });

		const rows = await db.select().from(weeklyPoints).where(eq(weeklyPoints.userId, player.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].points).toBeGreaterThan(0);
	});

	it('imports local-only history as imported_history, resolving quizName/rounds/isDaily server-side', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'official', trackCount: 4, name: 'Année 2013' });
		const player = await createUser(db);

		const result = await importGuest(db, player.id, {
			guestId: 'guest-no-sessions',
			history: [
				{ sessionId: 'aaaaaaaaaaaa', quizId: quizRow.id, score: 350, playedAt: 123 },
				{ sessionId: 'bbbbbbbbbbbb', quizId: 'deleted-quiz1', score: 50, playedAt: 456 }
			]
		});
		expect(result.importedHistoryRows).toBe(2);

		const rows = await db
			.select()
			.from(importedHistory)
			.where(eq(importedHistory.userId, player.id));
		expect(rows).toHaveLength(2);

		const known = rows.find((r) => r.totalScore === 350);
		expect(known?.quizName).toBe('Année 2013');
		expect(known?.rounds).toBe(4);
		expect(known?.isDaily).toBe(false);
		expect(known?.imported).toBe(true);

		const deleted = rows.find((r) => r.totalScore === 50);
		expect(deleted?.quizId).toBeNull();
		expect(deleted?.quizName).toBeNull();
		expect(deleted?.rounds).toBe(0);
	});

	it('never double-credits weekly_points for a session that was already the account\'s own', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'daily' });
		const player = await createUser(db);

		await createGameSession(db, quizRow, {
			guestId: null,
			userId: player.id,
			dailyDay: '2026-08-01',
			scored: true,
			totalScore: 900,
			finalizedAt: 5000,
			status: 'completed'
		});
		await db.insert(weeklyPoints).values({ userId: player.id, week: '2026-W31', points: 200 });

		await importGuest(db, player.id, { guestId: 'guest-unrelated', history: [] });

		const rows = await db.select().from(weeklyPoints).where(eq(weeklyPoints.userId, player.id));
		// Untouched — the pre-existing session was never re-attributed by this import.
		expect(rows.find((r) => r.week === '2026-W31')?.points).toBe(200);
	});
});
