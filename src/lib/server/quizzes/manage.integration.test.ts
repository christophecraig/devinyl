/**
 * Manual quiz lifecycle — CREATE-1..4/6/10, plan tasks 2.6/2.7/2.8.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	createGameSession,
	createQuiz,
	createUser,
	ensureMigrations,
	FakeCatalogProvider,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { challenge, quiz, quizTrack } from '../db/schema.js';
import { newChallengeToken } from '../ids.js';
import {
	createManualQuiz,
	deleteQuiz,
	duplicateQuiz,
	getQuizForLobby,
	listMyQuizzes,
	patchQuiz,
	saveGeneratedQuiz
} from './manage.js';

const db = testDb();
const provider = new FakeCatalogProvider();

/** `ensureTrackCached` HEAD/GETs the preview URL for availability — stub it to 206 (MUS-5's happy path). */
function fetchStub(status = 206): typeof fetch {
	return (async () =>
		new Response(new Uint8Array([0, 1]), {
			status,
			headers: { 'content-range': 'bytes 0-1/479827' }
		})) as typeof fetch;
}

const FIVE_TRACK_IDS = [
	'deezer:3135553',
	'deezer:62847142',
	'deezer:78454982',
	'deezer:823814',
	'deezer:111111'
];

describe('quizzes/manage (tasks 2.6/2.7/2.8)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	describe('createManualQuiz (CREATE-1/2)', () => {
		it('builds a real quiz + quiz_track rows from provider track ids', async () => {
			const owner = await createUser(db);

			const { quizId } = await createManualQuiz(
				db,
				provider,
				owner.id,
				{ name: 'My Quiz', tracks: FIVE_TRACK_IDS },
				Date.now(),
				{ fetchImpl: fetchStub() }
			);

			const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId));
			expect(row.kind).toBe('manual');
			expect(row.ownerId).toBe(owner.id);
			expect(row.name).toBe('My Quiz');

			const tracks = await db.select().from(quizTrack).where(eq(quizTrack.quizId, quizId));
			expect(tracks).toHaveLength(5);
			expect(tracks.every((t) => t.choices === null)).toBe(true);
		});

		it('builds 4-option choices per target when answerMode is choice', async () => {
			const owner = await createUser(db);

			const { quizId } = await createManualQuiz(
				db,
				provider,
				owner.id,
				{ name: 'Choice Quiz', tracks: FIVE_TRACK_IDS, settings: { answerMode: 'choice' } },
				Date.now(),
				{ fetchImpl: fetchStub() }
			);

			const tracks = await db.select().from(quizTrack).where(eq(quizTrack.quizId, quizId));
			for (const t of tracks) {
				expect(t.choices?.title).toHaveLength(4);
				expect(t.choices?.artist).toHaveLength(4);
			}
		});

		it('refuses the whole write (MUS-5) when one track has no playable preview', async () => {
			const owner = await createUser(db);
			const flaky = new FakeCatalogProvider();
			flaky.failPreviewFor('deezer:823814');

			await expect(
				createManualQuiz(
					db,
					flaky,
					owner.id,
					{ name: 'Bad Quiz', tracks: FIVE_TRACK_IDS },
					Date.now(),
					{ fetchImpl: fetchStub() }
				)
			).rejects.toThrow();

			const rows = await db.select().from(quiz).where(eq(quiz.name, 'Bad Quiz'));
			expect(rows).toHaveLength(0);
		});
	});

	describe('patchQuiz (CREATE-3)', () => {
		it('lets the owner rename and re-describe freely', async () => {
			const owner = await createUser(db);
			const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id, name: 'Old name' });

			await patchQuiz(db, provider, quizRow.id, owner.id, false, {
				name: 'New name',
				description: 'New description'
			});

			const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
			expect(row.name).toBe('New name');
			expect(row.description).toBe('New description');
		});

		it('rejects a non-owner, non-operator edit as forbidden', async () => {
			const owner = await createUser(db);
			const stranger = await createUser(db, {
				email: 'stranger@example.test',
				displayName: 'Stranger',
				displayNameNormalized: 'stranger'
			});
			const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id });

			await expect(
				patchQuiz(db, provider, quizRow.id, stranger.id, false, { name: 'Hijacked' })
			).rejects.toThrow();
		});

		it('409s a content edit once the quiz has been challenged', async () => {
			const owner = await createUser(db);
			const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id });
			await db.insert(challenge).values({
				token: newChallengeToken(),
				quizId: quizRow.id,
				creatorUserId: owner.id
			});

			await expect(
				patchQuiz(
					db,
					provider,
					quizRow.id,
					owner.id,
					false,
					{ tracks: FIVE_TRACK_IDS },
					Date.now(),
					{ fetchImpl: fetchStub() }
				)
			).rejects.toThrow();

			// Name/description still go through even though content is frozen.
			await patchQuiz(db, provider, quizRow.id, owner.id, false, { name: 'Still renamable' });
			const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
			expect(row.name).toBe('Still renamable');
		});

		it('409s a content edit once the quiz has a scored run', async () => {
			const owner = await createUser(db);
			const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id });
			await createGameSession(db, quizRow, { scored: true, status: 'completed' });

			await expect(
				patchQuiz(db, provider, quizRow.id, owner.id, false, {
					settings: { scoringMode: 'fixed' }
				})
			).rejects.toThrow();
		});

		it('lets an operator edit an unowned official quiz', async () => {
			const operator = await createUser(db, { isOperator: true });
			const { quiz: quizRow } = await createQuiz(db, { ownerId: null, kind: 'official' });

			await patchQuiz(db, provider, quizRow.id, operator.id, true, { name: 'Curated name' });
			const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
			expect(row.name).toBe('Curated name');
		});
	});

	describe('deleteQuiz (CREATE-4)', () => {
		it('soft-deletes — the row survives with deletedAt set', async () => {
			const owner = await createUser(db);
			const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id });

			await deleteQuiz(db, quizRow.id, owner.id, false);

			const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
			expect(row.deletedAt).not.toBeNull();

			await expect(getQuizForLobby(db, quizRow.id)).rejects.toThrow();
		});
	});

	describe('duplicateQuiz (CREATE-10)', () => {
		it('copies tracks and choices into a new manual quiz owned by the duplicator', async () => {
			const owner = await createUser(db);
			const duplicator = await createUser(db, {
				email: 'dup@example.test',
				displayName: 'Dup',
				displayNameNormalized: 'dup'
			});
			const { quiz: quizRow } = await createQuiz(db, {
				ownerId: owner.id,
				trackCount: 3,
				answerMode: 'choice'
			});

			const { quizId } = await duplicateQuiz(db, quizRow.id, duplicator.id);

			const [copy] = await db.select().from(quiz).where(eq(quiz.id, quizId));
			expect(copy.ownerId).toBe(duplicator.id);
			expect(copy.kind).toBe('manual');
			expect(copy.name).toContain(quizRow.name);

			const copiedTracks = await db.select().from(quizTrack).where(eq(quizTrack.quizId, quizId));
			expect(copiedTracks).toHaveLength(3);
			expect(copiedTracks.every((t) => t.choices !== null)).toBe(true);
		});
	});

	describe('saveGeneratedQuiz (CREATE-6)', () => {
		it('claims an unowned generated quiz and clears its TTL', async () => {
			const player = await createUser(db);
			const { quiz: quizRow } = await createQuiz(db, { ownerId: null, kind: 'generated' });
			await db.update(quiz).set({ ephemeralUntil: Date.now() + 1000 }).where(eq(quiz.id, quizRow.id));

			await saveGeneratedQuiz(db, quizRow.id, player.id);

			const [row] = await db.select().from(quiz).where(eq(quiz.id, quizRow.id));
			expect(row.ownerId).toBe(player.id);
			expect(row.ephemeralUntil).toBeNull();
		});

		it('refuses to save an already-owned quiz', async () => {
			const owner = await createUser(db);
			const other = await createUser(db, {
				email: 'other@example.test',
				displayName: 'Other',
				displayNameNormalized: 'other'
			});
			const { quiz: quizRow } = await createQuiz(db, { ownerId: owner.id, kind: 'generated' });

			await expect(saveGeneratedQuiz(db, quizRow.id, other.id)).rejects.toThrow();
		});
	});

	describe('reads', () => {
		it('getQuizForLobby returns the round count', async () => {
			const { quiz: quizRow } = await createQuiz(db, { trackCount: 4 });
			const result = await getQuizForLobby(db, quizRow.id);
			expect(result.roundCount).toBe(4);
		});

		it('listMyQuizzes excludes other owners and soft-deleted rows', async () => {
			const owner = await createUser(db);
			const other = await createUser(db, {
				email: 'other2@example.test',
				displayName: 'Other2',
				displayNameNormalized: 'other2'
			});
			const { quiz: mine } = await createQuiz(db, { ownerId: owner.id, name: 'Mine' });
			await createQuiz(db, { ownerId: other.id, name: 'Not mine' });
			const { quiz: deleted } = await createQuiz(db, { ownerId: owner.id, name: 'Deleted' });
			await db.update(quiz).set({ deletedAt: Date.now() }).where(eq(quiz.id, deleted.id));

			const rows = await listMyQuizzes(db, owner.id);
			expect(rows.map((r) => r.id)).toEqual([mine.id]);
		});
	});
});
