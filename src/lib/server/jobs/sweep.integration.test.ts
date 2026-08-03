/**
 * Ephemeral-quiz promotion + sweep integration tests — plan task 1.19,
 * technical-spec §6 ("promotion on use") and §15 (hourly sweep). Runs against
 * real D1 via `@cloudflare/vitest-pool-workers`, so `sweepEphemeralQuizzes`'s
 * `NOT EXISTS` leaf check and `finalizeSession`'s promotion write are
 * exercised together, not against a hand-rolled fake `Db` the way
 * `jobs/index.test.ts` covers the sweep functions in isolation.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Player } from '../identity.js';
import { quiz, quizTrack } from '../db/schema.js';
import { finalizeSession } from '../sessions/finalize.js';
import { recordRoundResult } from '../sessions/rounds.js';
import {
	createGameSession,
	createQuiz,
	ensureMigrations,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { sweepEphemeralQuizzes } from './index.js';

const db = testDb();
const IP_HASH_SECRET = 'test-ip-hash-secret';
const CLIENT_IP = '203.0.113.5';
const player: Player = { kind: 'guest', userId: null, guestId: 'fixture-guest' };

/** §6: 24h TTL for a `kind: 'generated'` quiz nobody has used yet. */
const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
	await ensureMigrations();
});

beforeEach(async () => {
	await resetDb(db);
});

describe('ephemeral promotion on use (§6) + hourly sweep (§15)', () => {
	it('a played, scored quiz has ephemeral_until cleared and survives the sweep', async () => {
		const now = 0;
		const { quiz: quizRow, tracks } = await createQuiz(db, {
			trackCount: 1,
			guessTarget: 'title',
			kind: 'generated'
		});
		await db
			.update(quiz)
			.set({ ephemeralUntil: now + EPHEMERAL_TTL_MS })
			.where(eq(quiz.id, quizRow.id));

		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: now
		});
		await recordRoundResult(
			db,
			session,
			{
				position: 0,
				guessLog: [{ target: 'title', raw: tracks[0].title, atMs: 5_000 }],
				lockTimes: { title: 5_000 },
				clipMs: 30_000,
				skipped: false
			},
			5_500
		);

		const finalizedAt = now + 40_000;
		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: finalizedAt
		});
		expect(result.scored).toBe(true);

		const [afterFinalize] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
		expect(afterFinalize.ephemeralUntil).toBeNull();

		// Sweep runs long after the original TTL would have expired — promotion,
		// not the TTL, is what keeps a played quiz alive.
		const deleted = await sweepEphemeralQuizzes(db, now + EPHEMERAL_TTL_MS + 60_000);
		expect(deleted).toBe(0);

		const [afterSweep] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
		expect(afterSweep).toBeDefined();
	});

	it('an unplayed quiz past its TTL is deleted by the sweep, along with its quiz_track children', async () => {
		const now = 0;
		const { quiz: quizRow, quizTracks } = await createQuiz(db, {
			trackCount: 2,
			kind: 'generated'
		});
		await db
			.update(quiz)
			.set({ ephemeralUntil: now + EPHEMERAL_TTL_MS })
			.where(eq(quiz.id, quizRow.id));

		expect(quizTracks).toHaveLength(2);

		// Before the TTL: the sweep must not touch it yet.
		expect(await sweepEphemeralQuizzes(db, now + EPHEMERAL_TTL_MS - 1_000)).toBe(0);
		expect(await db.select().from(quiz).where(eq(quiz.id, quizRow.id))).toHaveLength(1);

		// Past the TTL, still unplayed (no game_session/challenge/daily_quiz row
		// references it) — this is the leaf condition sweepEphemeralQuizzes checks.
		const deleted = await sweepEphemeralQuizzes(db, now + EPHEMERAL_TTL_MS + 1_000);
		expect(deleted).toBe(1);

		expect(await db.select().from(quiz).where(eq(quiz.id, quizRow.id))).toHaveLength(0);
		expect(await db.select().from(quizTrack).where(eq(quizTrack.quizId, quizRow.id))).toHaveLength(
			0
		);
	});

	it('leaves a non-generated (e.g. manual) quiz alone even past an ephemeral_until, since only "generated" is ever swept', async () => {
		const now = 0;
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 1, kind: 'manual' });
		// A manual quiz never legitimately carries an ephemeral_until, but the
		// sweep's `kind = 'generated'` filter must be what protects it, not an
		// accident of this value being unset.
		await db
			.update(quiz)
			.set({ ephemeralUntil: now - 1 })
			.where(eq(quiz.id, quizRow.id));

		expect(await sweepEphemeralQuizzes(db, now)).toBe(0);
		expect(await db.select().from(quiz).where(eq(quiz.id, quizRow.id))).toHaveLength(1);
	});
});
