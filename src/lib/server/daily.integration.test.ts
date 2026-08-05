/**
 * Daily quiz — DAILY-1/2/5, FAIR-7, plan task 3.1.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Player } from './identity.js';
import { scheduleDaily } from './admin/index.js';
import { checkDailyPublicationGap, getDaily } from './daily.js';
import { dailyQuiz } from './db/schema.js';
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

/** Answers every round of `manifest` correctly, so finalize has something to score. */
async function playAllRounds(
	manifest: SessionManifest,
	tracks: TrackCacheRow[],
	player: Player,
	startedAt: number
): Promise<void> {
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
}

beforeAll(async () => {
	await ensureMigrations();
});
beforeEach(async () => {
	await resetDb(db);
});

describe('getDaily (DAILY-1/2/5)', () => {
	it('404s when no quiz is scheduled for the day', async () => {
		await expect(
			getDaily(db, null, '2026-01-01', Date.parse('2026-01-01T12:00:00Z'))
		).rejects.toThrow();
	});

	it('resolves the scheduled quiz, round count, and day number', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'official', trackCount: 3 });
		await scheduleDaily(db, '2026-08-10', quizRow.id);

		const now = Date.parse('2026-08-10T12:00:00+02:00');
		const info = await getDaily(db, null, undefined, now);

		expect(info.day).toBe('2026-08-10');
		expect(info.quizId).toBe(quizRow.id);
		expect(info.rounds).toBe(3);
		expect(info.isToday).toBe(true);
		expect(info.alreadyPlayed).toBe(false);
	});

	it('reports alreadyPlayed once a player has a scored run that day', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { kind: 'official', trackCount: 1 });
		await scheduleDaily(db, '2026-08-10', quizRow.id);
		const now = Date.parse('2026-08-10T12:00:00+02:00');

		const player: Player = { kind: 'guest', userId: null, guestId: 'guest-1' };
		const manifest = await createSession(db, provider, {
			target: { kind: 'daily' },
			player,
			nickname: 'Player One',
			now
		});
		await playAllRounds(manifest, tracks, player, now);
		await finalizeSession(db, {
			sessionId: manifest.sessionId,
			player,
			body: {},
			clientIp: '203.0.113.9',
			ipHashSecret: IP_HASH_SECRET,
			now: now + 31_000
		});
		const info = await getDaily(db, player, undefined, now);
		expect(info.alreadyPlayed).toBe(true);
	});

	it('refuses a day in the future', async () => {
		const now = Date.parse('2026-08-10T12:00:00+02:00');
		await expect(getDaily(db, null, '2026-08-11', now)).rejects.toThrow();
	});
});

describe('checkDailyPublicationGap (§15)', () => {
	it('reports a gap when tomorrow has no scheduled quiz', async () => {
		const now = Date.parse('2026-08-10T00:05:00+02:00');
		const result = await checkDailyPublicationGap(db, now);
		expect(result.ok).toBe(false);
		expect(result.day).toBe('2026-08-11');
	});

	it('reports no gap once tomorrow is scheduled', async () => {
		const { quiz: quizRow } = await createQuiz(db, { kind: 'official' });
		await scheduleDaily(db, '2026-08-11', quizRow.id);

		const now = Date.parse('2026-08-10T00:05:00+02:00');
		const result = await checkDailyPublicationGap(db, now);
		expect(result.ok).toBe(true);
	});
});

describe('FAIR-7 guest daily dedupe, end to end through createSession + finalizeSession', () => {
	it('scores the first guest and demotes a second guest id from the same IP to a replay', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { kind: 'official', trackCount: 1 });
		await scheduleDaily(db, '2026-08-10', quizRow.id);
		const now = Date.parse('2026-08-10T12:00:00+02:00');
		const ip = '203.0.113.9';

		const first: Player = { kind: 'guest', userId: null, guestId: 'guest-a' };
		const manifestA = await createSession(db, provider, {
			target: { kind: 'daily' },
			player: first,
			nickname: 'Player A',
			now
		});
		await playAllRounds(manifestA, tracks, first, now);
		const resultA = await finalizeSession(db, {
			sessionId: manifestA.sessionId,
			player: first,
			body: {},
			clientIp: ip,
			ipHashSecret: IP_HASH_SECRET,
			now: now + 31_000
		});
		expect(resultA.scored).toBe(true);

		const second: Player = { kind: 'guest', userId: null, guestId: 'guest-b' };
		const manifestB = await createSession(db, provider, {
			target: { kind: 'daily' },
			player: second,
			nickname: 'Player B',
			now: now + 1_000
		});
		await playAllRounds(manifestB, tracks, second, now + 1_000);
		const resultB = await finalizeSession(db, {
			sessionId: manifestB.sessionId,
			player: second,
			body: {},
			clientIp: ip,
			ipHashSecret: IP_HASH_SECRET,
			now: now + 31_000
		});

		// FAIR-7: a different guest_id claiming the same (day, ipHash) is treated
		// as a replay — fails open toward letting the player play, unscored.
		expect(resultB.scored).toBe(false);
		expect(resultB.scoredBlockReason).toBe('replay');
	});

	it('the same guest id finalizing twice (retry) stays idempotent, not a double replay block', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { kind: 'official', trackCount: 1 });
		await scheduleDaily(db, '2026-08-10', quizRow.id);
		const now = Date.parse('2026-08-10T12:00:00+02:00');
		const player: Player = { kind: 'guest', userId: null, guestId: 'guest-a' };

		const manifest = await createSession(db, provider, {
			target: { kind: 'daily' },
			player,
			nickname: 'Player A',
			now
		});
		await playAllRounds(manifest, tracks, player, now);
		const first = await finalizeSession(db, {
			sessionId: manifest.sessionId,
			player,
			body: {},
			clientIp: '203.0.113.9',
			ipHashSecret: IP_HASH_SECRET,
			now: now + 31_000
		});
		const retried = await finalizeSession(db, {
			sessionId: manifest.sessionId,
			player,
			body: {},
			clientIp: '203.0.113.9',
			ipHashSecret: IP_HASH_SECRET,
			now: now + 31_500
		});

		expect(retried.scored).toBe(first.scored);
		expect(retried.totalScore).toBe(first.totalScore);
	});
});

// Sanity: dailyQuiz row itself carries the day-number sequencing getDaily reads.
describe('dailyQuiz row shape', () => {
	it('scheduleDaily assigns sequential day numbers', async () => {
		const { quiz: a } = await createQuiz(db, { kind: 'official', name: 'A' });
		const { quiz: b } = await createQuiz(db, { kind: 'official', name: 'B' });
		await scheduleDaily(db, '2026-08-10', a.id);
		await scheduleDaily(db, '2026-08-11', b.id);

		const rows = await db.select().from(dailyQuiz).orderBy(dailyQuiz.day);
		expect(rows.map((r) => r.dayNumber)).toEqual([1, 2]);
	});
});
