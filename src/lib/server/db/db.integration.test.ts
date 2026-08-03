import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	createGameSession,
	createQuiz,
	createRoundResult,
	createTrack,
	createUser,
	ensureMigrations,
	FakeCatalogProvider,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { gameSession, quiz, quizTrack, roundResult, trackCache } from './schema.js';

// Trivial integration test proving @cloudflare/vitest-pool-workers (S.3) runs
// against a real local D1 instance in the actual Workers runtime.
describe('local D1 binding', () => {
	it('is bound and queryable', async () => {
		const result = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>();
		expect(result?.one).toBe(1);
	});
});

// Proves the harness itself (plan task 1.19) — migrations, reset, fixtures,
// and FK enforcement — so later suites (finalize, rounds, scoring) can build
// on it without re-verifying any of this themselves.
describe('integration-test harness', () => {
	const db = testDb();

	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	describe('migrations', () => {
		it('applies 0000 — the base schema exists and is queryable', async () => {
			const rows = await db.select().from(quiz);
			expect(rows).toEqual([]);
		});

		it('applies 0001 — rate_limit exists', async () => {
			// A raw pragma read rather than a Drizzle query: this is asserting the
			// table exists at all, which a schema-typed select can't distinguish
			// from "exists but empty" if the migration silently failed to apply.
			const info = await env.DB.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit'"
			).first();
			expect(info).not.toBeNull();
		});

		it('applies 0001 — round_result gained claimed_title_ms, claimed_artist_ms, server_received_at', async () => {
			const columns = await env.DB.prepare('PRAGMA table_info(round_result)').all<{
				name: string;
			}>();
			const names = columns.results.map((c) => c.name);
			expect(names).toEqual(
				expect.arrayContaining(['claimed_title_ms', 'claimed_artist_ms', 'server_received_at'])
			);
		});
	});

	describe('resetDb', () => {
		it('clears rows inserted by a previous test — no cross-test leakage', async () => {
			await createTrack(db);
			expect(await db.select().from(trackCache)).toHaveLength(1);

			await resetDb(db);

			expect(await db.select().from(trackCache)).toHaveLength(0);
		});
	});

	describe('fixture builders', () => {
		it('createTrack inserts a track_cache row with real answer keys', async () => {
			const track = await createTrack(db);

			const [stored] = await db.select().from(trackCache).where(eq(trackCache.id, track.id));
			expect(stored.title).toBe('One More Time');
			// buildAnswerKey (game/match.ts, §5.4) normalizes number words, so "One"
			// becomes "1" — asserting the literal lowercase title would be wrong.
			expect(stored.answers.title.length).toBeGreaterThan(0);
		});

		it('createQuiz(answerMode: "text") builds tracks with no choices', async () => {
			const {
				quiz: quizRow,
				tracks,
				quizTracks
			} = await createQuiz(db, { trackCount: 3, answerMode: 'text' });

			expect(quizRow.answerMode).toBe('text');
			expect(tracks).toHaveLength(3);
			expect(quizTracks).toHaveLength(3);
			for (const qt of quizTracks) expect(qt.choices).toBeNull();
		});

		it('createQuiz(answerMode: "choice") builds 4-option choices per requested target', async () => {
			const { quizTracks } = await createQuiz(db, {
				trackCount: 3,
				answerMode: 'choice',
				guessTarget: 'both'
			});

			for (const qt of quizTracks) {
				expect(qt.choices?.title).toHaveLength(4);
				expect(qt.choices?.artist).toHaveLength(4);
			}
		});

		it('createGameSession + createRoundResult build a playable-run graph', async () => {
			const { quiz: quizRow } = await createQuiz(db, { trackCount: 2 });
			const session = await createGameSession(db, quizRow);
			const round = await createRoundResult(db, session, 0, { titleMs: 1200, points: 800 });

			expect(session.quizId).toBe(quizRow.id);
			expect(round.sessionId).toBe(session.id);

			const stored = await db
				.select()
				.from(roundResult)
				.where(eq(roundResult.sessionId, session.id));
			expect(stored).toHaveLength(1);
			expect(stored[0].points).toBe(800);
		});
	});

	describe('foreign keys', () => {
		it('rejects a quiz_track referencing a track_cache row that does not exist', async () => {
			const { quiz: quizRow } = await createQuiz(db, { trackCount: 1 });

			await expect(
				db.insert(quizTrack).values({
					quizId: quizRow.id,
					position: 99,
					trackId: 'deezer:does-not-exist'
				})
			).rejects.toThrow();
		});

		it('rejects a game_session referencing a quiz that does not exist', async () => {
			// A structurally valid QuizRow with a dangling id — the FK is what
			// must reject this, not a missing column.
			const { quiz: quizRow } = await createQuiz(db, { trackCount: 1 });
			await expect(createGameSession(db, { ...quizRow, id: 'not-a-real-quiz' })).rejects.toThrow();
		});

		it('cascades: deleting a game_session deletes its round_result rows', async () => {
			const { quiz: quizRow } = await createQuiz(db, { trackCount: 1 });
			const session = await createGameSession(db, quizRow);
			await createRoundResult(db, session, 0);

			await db.delete(gameSession).where(eq(gameSession.id, session.id));

			const remaining = await db
				.select()
				.from(roundResult)
				.where(eq(roundResult.sessionId, session.id));
			expect(remaining).toHaveLength(0);
		});
	});

	describe('FakeCatalogProvider', () => {
		it('resolves preview URLs deterministically, no network', async () => {
			const provider = new FakeCatalogProvider();
			const track = await provider.getTrack('deezer:3135553');
			expect(track?.title).toBe('One More Time');

			const url = await provider.getPreviewUrl('deezer:3135553');
			expect(url).toBe('https://fixture.test/preview/3135553.mp3');
		});

		it('failPreviewFor makes getPreviewUrl resolve null — the FAIR-6 skipped-round knob', async () => {
			const provider = new FakeCatalogProvider();
			provider.failPreviewFor('deezer:3135553');

			expect(await provider.getPreviewUrl('deezer:3135553')).toBeNull();
			// Unaffected tracks are untouched.
			expect(await provider.getPreviewUrl('deezer:62847142')).not.toBeNull();
		});
	});

	// Exercised indirectly by every test above via createUser/createQuiz's
	// ownerId, but asserted directly once so a future test can rely on it.
	it('createUser inserts a user row usable as a quiz owner', async () => {
		const owner = await createUser(db);
		const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id });
		expect(quizRow.ownerId).toBe(owner.id);
	});
});
