/**
 * Full-lifecycle + finalize re-validation integration tests — plan task 1.19,
 * technical-spec §7.1–§7.3. Runs against real D1 via
 * `@cloudflare/vitest-pool-workers` (see `vitest.integration.config.ts`), so
 * these exercise the actual round-trip `create.ts` → `rounds.ts` →
 * `finalize.ts` → `revalidate.ts` takes in production, not a hand-rolled fake
 * `Db`. `revalidate.test.ts` and `finalize.test.ts` already cover the pure
 * engine and identity-precedence logic in isolation; this file is about the
 * D1-shaped wiring around them and the plausibility-tier boundaries that only
 * make sense with real rows (server-observed beacons, `serverReceivedAt`,
 * wall-clock gaps).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scoreRound } from '$lib/game/scoring.js';
import type { Player } from '../identity.js';
import { LIMITS, consume } from '../ratelimit.js';
import {
	createGameSession,
	createQuiz,
	createRoundResult,
	ensureMigrations,
	FakeCatalogProvider,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { createSession, loadOwnedSession } from './create.js';
import { finalizeSession } from './finalize.js';
import { recordBeacon, recordRoundResult } from './rounds.js';

const db = testDb();
const IP_HASH_SECRET = 'test-ip-hash-secret';
const CLIENT_IP = '203.0.113.5';

const player: Player = { kind: 'guest', userId: null, guestId: 'fixture-guest' };

beforeAll(async () => {
	await ensureMigrations();
});

beforeEach(async () => {
	await resetDb(db);
});

// ---------------------------------------------------------------------------
// 1. Full session lifecycle
// ---------------------------------------------------------------------------

describe('full session lifecycle (§7.1–§7.3)', () => {
	it('create → beacons → results → finalize yields a score matching the pure scoring functions', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, {
			trackCount: 2,
			guessTarget: 'both',
			answerMode: 'text'
		});
		const provider = new FakeCatalogProvider();
		const startedAt = 0;

		const manifest = await createSession(db, provider, {
			target: { kind: 'quiz', quizId: quizRow.id },
			player,
			nickname: 'Fixture Player',
			now: startedAt
		});

		// Manifest carries no plaintext answers (MUS-4) — reveal data is inside the
		// encrypted per-round pack, so the round list only proves the shape, not
		// the content.
		expect(manifest.rounds).toHaveLength(2);
		expect(manifest.rounds.every((r) => !r.skipped)).toBe(true);

		let session = await loadOwnedSession(db, manifest.sessionId, player);

		const lockTimes = [
			{ title: 4_000, artist: 6_000 },
			{ title: 9_000, artist: 11_000 }
		];

		for (const round of manifest.rounds) {
			await recordBeacon(db, session, round.position, startedAt + round.position * 15_000);
			session = await loadOwnedSession(db, manifest.sessionId, player);

			const track = tracks[round.position];
			const { title: titleMs, artist: artistMs } = lockTimes[round.position];
			await recordRoundResult(
				db,
				session,
				{
					position: round.position,
					guessLog: [
						{ target: 'title', raw: track.title, atMs: titleMs },
						{ target: 'artist', raw: track.artists[0].name, atMs: artistMs }
					],
					lockTimes: { title: titleMs, artist: artistMs },
					clipMs: 30_000,
					skipped: false
				},
				startedAt + round.position * 15_000 + Math.max(titleMs, artistMs)
			);
		}

		const finalizedAt = startedAt + 60_000;
		const result = await finalizeSession(db, {
			sessionId: manifest.sessionId,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: finalizedAt
		});

		expect(result.scored).toBe(true);
		expect(result.scoredBlockReason).toBeNull();

		const expectedTotal = lockTimes.reduce(
			(sum, { title, artist }) =>
				sum +
				scoreRound(
					{
						title: { correct: true, lockMs: title },
						artist: { correct: true, lockMs: artist },
						clipMs: 30_000
					},
					'speed',
					1
				),
			0
		);
		expect(result.totalScore).toBe(expectedTotal);
		expect(result.rounds).toHaveLength(2);
		for (const [i, round] of result.rounds.entries()) {
			expect(round.titleOk).toBe(true);
			expect(round.artistOk).toBe(true);
			expect(round.titleMs).toBe(lockTimes[i].title);
			expect(round.artistMs).toBe(lockTimes[i].artist);
		}
	});

	it('is idempotent — a retried finalize returns the already-stored verdict without rescoring', async () => {
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 1 });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});
		await createRoundResult(db, session, 0, {
			guessLog: [],
			claimedTitleMs: null,
			claimedArtistMs: null,
			serverReceivedAt: 1_000
		});

		const first = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 10_000
		});
		const second = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			// A very different `now` — if this re-ran the engine, `finalizedAt` would
			// change and prove the idempotency guard did not fire.
			now: 999_999
		});

		expect(second.finalizedAt).toBe(first.finalizedAt);
		expect(second.totalScore).toBe(first.totalScore);
	});
});

// ---------------------------------------------------------------------------
// 2. Plausibility tiers (§7.3 step 3)
// ---------------------------------------------------------------------------

describe('finalize re-validation — plausibility tiers', () => {
	it('verified tier: a server-observed beacon for every round scores the run', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, guessTarget: 'title' });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});

		await recordBeacon(db, session, 0, 0);
		const beaconed = await loadOwnedSession(db, session.id, player);
		await recordRoundResult(
			db,
			beaconed,
			{
				position: 0,
				guessLog: [{ target: 'title', raw: tracks[0].title, atMs: 5_000 }],
				lockTimes: { title: 5_000 },
				clipMs: 30_000,
				skipped: false
			},
			5_500
		);

		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 40_000
		});

		expect(result.scored).toBe(true);
		expect(result.scoredBlockReason).toBeNull();
	});

	it('reconstructed tier only (fully offline run, no beacons) scores when the offline invariants hold', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, guessTarget: 'title' });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});

		// No `recordBeacon` call at all — the connection dropped for the whole
		// round, per MUS-7. `recordRoundResult` still stamps `serverReceivedAt`
		// (the result POST itself reached the server, even though the beacon
		// didn't), which is what lands this in 'reconstructed' rather than 'none'.
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
			35_000
		);

		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 40_000
		});

		expect(result.scored).toBe(true);
		expect(result.scoredBlockReason).toBeNull();
	});

	it('failing only the verified tier does not block scoring (MUS-7)', async () => {
		// The beacon is observed, but the round result is posted almost
		// immediately after it while the player *claims* a lock 28s into a 30s
		// clip — impossible inside that short a server-observed window, so the
		// verified tier's own cross-check fails. The reconstructed-tier
		// invariants (monotonic log, lock inside [0, clipMs], wall clock) all
		// still hold, so per revalidate.ts's contract this must not be
		// disqualifying: a connection drop between beacon and receipt is exactly
		// what MUS-7 promises survives.
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, guessTarget: 'title' });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});

		await recordBeacon(db, session, 0, 0);
		const beaconed = await loadOwnedSession(db, session.id, player);
		await recordRoundResult(
			db,
			beaconed,
			{
				position: 0,
				guessLog: [{ target: 'title', raw: tracks[0].title, atMs: 28_000 }],
				lockTimes: { title: 28_000 },
				clipMs: 30_000,
				skipped: false
			},
			1_000 // received 1s after the beacon, but the claim is 28s of clip time
		);

		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 40_000
		});

		expect(result.scored).toBe(true);
		expect(result.scoredBlockReason).toBeNull();
		expect(result.rounds[0].titleOk).toBe(true);
	});

	it('failing the reconstructed tier blocks scoring with "implausible"', async () => {
		// Guess timestamps run backwards — never possible from a real audio
		// clock — which the reconstructed tier explicitly checks for (isMonotonic)
		// regardless of whether a beacon exists.
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, guessTarget: 'title' });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});

		await recordRoundResult(
			db,
			session,
			{
				position: 0,
				guessLog: [
					{ target: 'title', raw: 'not the answer', atMs: 5_000 },
					{ target: 'title', raw: tracks[0].title, atMs: 2_000 }
				],
				lockTimes: { title: 2_000 },
				clipMs: 30_000,
				skipped: false
			},
			35_000
		);

		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 40_000
		});

		expect(result.scored).toBe(false);
		expect(result.scoredBlockReason).toBe('implausible');
	});
});

// ---------------------------------------------------------------------------
// 3. Skipped round ⇒ unscored (FAIR-6, MUS-5)
// ---------------------------------------------------------------------------

describe('skipped round ⇒ unscored (FAIR-6)', () => {
	it('any skipped round blocks the whole session with "clip_unavailable", but still returns a score', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 2, guessTarget: 'title' });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});

		await createRoundResult(db, session, 0, { skipped: true, clipMs: 30_000, guessLog: [] });
		await recordRoundResult(
			db,
			session,
			{
				position: 1,
				guessLog: [{ target: 'title', raw: tracks[1].title, atMs: 5_000 }],
				lockTimes: { title: 5_000 },
				clipMs: 30_000,
				skipped: false
			},
			35_000
		);

		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 40_000
		});

		// FAIR-6: the player still sees their score for the rounds they did play...
		expect(result.scored).toBe(false);
		expect(result.scoredBlockReason).toBe('clip_unavailable');
		expect(result.rounds.find((r) => r.position === 1)?.points).toBeGreaterThan(0);
		// ...but the skipped round itself carries no score, and the run never
		// posts to a board (`scored: false` above).
		expect(result.rounds.find((r) => r.position === 0)?.points).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 4. clipMs inflation rejected (§7.3 step 3)
// ---------------------------------------------------------------------------

describe('clipMs inflation rejected', () => {
	it('a claimed clipMs far beyond the known preview duration is disqualifying, not merely re-curved', async () => {
		// `createTrack`'s default preview duration is 30s (test-utils.integration.ts).
		// Claiming 90s buys a much gentler speed-curve denominator if trusted.
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, guessTarget: 'title' });
		const session = await createGameSession(db, quizRow, {
			userId: null,
			guestId: player.guestId,
			startedAt: 0
		});

		const inflatedClipMs = 90_000;
		await recordRoundResult(
			db,
			session,
			{
				position: 0,
				guessLog: [{ target: 'title', raw: tracks[0].title, atMs: 80_000 }],
				lockTimes: { title: 80_000 },
				clipMs: inflatedClipMs,
				skipped: false
			},
			120_000
		);

		const result = await finalizeSession(db, {
			sessionId: session.id,
			player,
			body: {},
			clientIp: CLIENT_IP,
			ipHashSecret: IP_HASH_SECRET,
			now: 130_000
		});

		// The inflated claim is rejected outright: the run is blocked from boards
		// rather than credited with the softer curve a 90s clip would imply.
		expect(result.scored).toBe(false);
		expect(result.scoredBlockReason).toBe('implausible');
	});
});

// ---------------------------------------------------------------------------
// 6. Rate limiting (§10, ratelimit.ts)
// ---------------------------------------------------------------------------

describe('rate limiting (§10)', () => {
	it('allows requests under the limit, then blocks once exceeded, then resets on the next window', async () => {
		const spec = { name: 'test_bucket', limit: 3, windowMs: 60_000 };
		const identity = 'guest_rate_limit_test';
		const windowStart = 0;

		for (let i = 1; i <= 3; i++) {
			const verdict = await consume(db, spec, identity, windowStart + i);
			expect(verdict.allowed).toBe(true);
			expect(verdict.remaining).toBe(spec.limit - i);
		}

		// The 4th request in the same window is over the limit.
		const blocked = await consume(db, spec, identity, windowStart + 4);
		expect(blocked.allowed).toBe(false);
		expect(blocked.remaining).toBe(0);
		expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

		// A timestamp in the next fixed window is a fresh bucket.
		const nextWindow = await consume(db, spec, identity, windowStart + spec.windowMs + 1);
		expect(nextWindow.allowed).toBe(true);
		expect(nextWindow.remaining).toBe(spec.limit - 1);
	});

	it('LIMITS.finalize is enforced independently per identity', async () => {
		const now = 0;
		const a = await consume(db, LIMITS.finalize, 'guest_a', now);
		const b = await consume(db, LIMITS.finalize, 'guest_b', now);
		expect(a.remaining).toBe(LIMITS.finalize.limit - 1);
		expect(b.remaining).toBe(LIMITS.finalize.limit - 1);
	});
});
