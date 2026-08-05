/**
 * Challenges + leaderboards — CHAL-1…4, STAT-2, plan tasks 3.5/3.6.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Player } from './identity.js';
import { createChallenge, loadChallengeLobby } from './challenges.js';
import { getBoard } from './boards.js';
import { quiz } from './db/schema.js';
import {
	createQuiz,
	ensureMigrations,
	FakeCatalogProvider,
	resetDb,
	testDb
} from './test-utils.integration.js';
import type { TrackCacheRow } from './catalog/assembly.js';
import { createSession, loadOwnedSession } from './sessions/create.js';
import { finalizeSession } from './sessions/finalize.js';
import { recordBeacon, recordRoundResult } from './sessions/rounds.js';
import type { SessionManifest } from '$lib/game/types.js';

const db = testDb();
const provider = new FakeCatalogProvider();
const IP_HASH_SECRET = 'test-ip-hash-secret';
const CLIENT_IP = '203.0.113.5';

beforeAll(async () => {
	await ensureMigrations();
});
beforeEach(async () => {
	await resetDb(db);
});

/** Answers every round correctly and finalizes ~31s later, clearing the reconstructed-tier wall-clock check. */
async function playAndFinalize(
	manifest: SessionManifest,
	tracks: TrackCacheRow[],
	player: Player,
	startedAt: number
) {
	for (const round of manifest.rounds) {
		let session = await loadOwnedSession(db, manifest.sessionId, player);
		await recordBeacon(db, session, round.position, startedAt);
		session = await loadOwnedSession(db, manifest.sessionId, player);
		const track = tracks[round.position];
		await recordRoundResult(
			db,
			session,
			{
				position: round.position,
				guessLog: [
					{ target: 'title', raw: track.title, atMs: 3_000 },
					{ target: 'artist', raw: track.artists[0].name, atMs: 4_000 }
				],
				lockTimes: { title: 3_000, artist: 4_000 },
				clipMs: 30_000,
				skipped: false
			},
			startedAt + 4_000
		);
	}
	return finalizeSession(db, {
		sessionId: manifest.sessionId,
		player,
		body: {},
		clientIp: CLIENT_IP,
		ipHashSecret: IP_HASH_SECRET,
		now: startedAt + 31_000
	});
}

describe('createChallenge (CHAL-1)', () => {
	it('creates a token from a finalized session and clears the quiz TTL', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, kind: 'generated' });
		await db
			.update(quiz)
			.set({ ephemeralUntil: Date.now() + 1000 })
			.where(eq(quiz.id, quizRow.id));

		const player: Player = { kind: 'guest', userId: null, guestId: 'creator' };
		const now = Date.now();
		const manifest = await createSession(db, provider, {
			target: { kind: 'quiz', quizId: quizRow.id },
			player,
			nickname: 'Creator',
			now
		});
		await playAndFinalize(manifest, tracks, player, now);

		const { token } = await createChallenge(db, { sessionId: manifest.sessionId, player });
		expect(token).toHaveLength(10);

		const lobby = await loadChallengeLobby(db, token);
		expect(lobby.quizId).toBe(quizRow.id);
		expect(lobby.challengerName).toBe('Creator');
		expect(lobby.rounds).toBe(1);
	});

	it('refuses to challenge from a session belonging to another player', async () => {
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 1 });
		const owner: Player = { kind: 'guest', userId: null, guestId: 'owner' };
		const stranger: Player = { kind: 'guest', userId: null, guestId: 'stranger' };
		const now = Date.now();
		const manifest = await createSession(db, provider, {
			target: { kind: 'quiz', quizId: quizRow.id },
			player: owner,
			nickname: 'Owner',
			now
		});

		await expect(
			createChallenge(db, { sessionId: manifest.sessionId, player: stranger })
		).rejects.toThrow();
	});

	it('refuses to challenge from a session that never finished', async () => {
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 1 });
		const player: Player = { kind: 'guest', userId: null, guestId: 'p' };
		const manifest = await createSession(db, provider, {
			target: { kind: 'quiz', quizId: quizRow.id },
			player,
			nickname: 'P',
			now: Date.now()
		});

		await expect(createChallenge(db, { sessionId: manifest.sessionId, player })).rejects.toThrow();
	});
});

describe('challenge board (CHAL-2) via getBoard', () => {
	it("holds only sessions played *through the link* — the creator's originating quiz session is a different board", async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1 });
		const creator: Player = { kind: 'guest', userId: null, guestId: 'creator' };
		const now = Date.now();
		const creatorManifest = await createSession(db, provider, {
			target: { kind: 'quiz', quizId: quizRow.id },
			player: creator,
			nickname: 'Creator',
			now
		});
		await playAndFinalize(creatorManifest, tracks, creator, now);
		const { token } = await createChallenge(db, {
			sessionId: creatorManifest.sessionId,
			player: creator
		});

		const challenger: Player = { kind: 'guest', userId: null, guestId: 'challenger' };
		const now2 = now + 100_000;
		const challengerManifest = await createSession(db, provider, {
			target: { kind: 'challenge', token },
			player: challenger,
			nickname: 'Challenger',
			now: now2
		});
		await playAndFinalize(challengerManifest, tracks, challenger, now2);

		const board = await getBoard(
			db,
			{ kind: 'challenge', token },
			{ mode: 'speed', player: challenger, friendsOnly: false }
		);

		// Only the run started against the challenge target carries challenge_token
		// — the creator's own originating session lives on the quiz's generic board.
		expect(board.entries.map((e) => e.name)).toEqual(['Challenger']);
		expect(board.selfEntry?.isSelf).toBe(true);
		expect(board.selfEntry?.name).toBe('Challenger');

		const quizBoard = await getBoard(
			db,
			{ kind: 'quiz', quizId: quizRow.id },
			{ mode: 'speed', player: creator, friendsOnly: false }
		);
		expect(quizBoard.entries.map((e) => e.name)).toEqual(['Creator']);
	});

	it('has no self row for an anonymous viewer, but still lists the challenge participant', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1 });
		const creator: Player = { kind: 'guest', userId: null, guestId: 'creator' };
		const now = Date.now();
		const creatorManifest = await createSession(db, provider, {
			target: { kind: 'quiz', quizId: quizRow.id },
			player: creator,
			nickname: 'Creator',
			now
		});
		await playAndFinalize(creatorManifest, tracks, creator, now);
		const { token } = await createChallenge(db, {
			sessionId: creatorManifest.sessionId,
			player: creator
		});

		const challenger: Player = { kind: 'guest', userId: null, guestId: 'challenger' };
		const now2 = now + 100_000;
		const challengerManifest = await createSession(db, provider, {
			target: { kind: 'challenge', token },
			player: challenger,
			nickname: 'Challenger',
			now: now2
		});
		await playAndFinalize(challengerManifest, tracks, challenger, now2);

		const board = await getBoard(
			db,
			{ kind: 'challenge', token },
			{ mode: 'speed', player: null, friendsOnly: false }
		);
		expect(board.selfEntry).toBeNull();
		expect(board.entries).toHaveLength(1);
		expect(board.entries[0].name).toBe('Challenger');
	});
});
