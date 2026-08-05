/**
 * Manual quiz creation and lifecycle — technical-spec CREATE-1..4/6/10, plan
 * tasks 2.6/2.7/2.8.
 *
 * Assembly (track resolution, availability-at-source, answer keys,
 * distractors) is the same machinery `generate.ts` uses (1B): `ensureTrackCached`
 * for MUS-5-at-source refusal, `buildRoundChoices` for choice-mode options.
 * Nothing here re-derives that logic — a manual quiz and a generated one only
 * differ in where the track list comes from.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { CreateQuizBody, PatchQuizBody } from '$lib/game/schemas.js';
import type { QuizSettings, RoundChoices, TargetName } from '$lib/game/types.js';
import { DEFAULT_QUIZ_SETTINGS } from '$lib/game/types.js';
import { CURRENT_CURVE_VERSION } from '$lib/game/scoring.js';
import type { Db } from '../db/index.js';
import { challenge, gameSession, quiz, quizTrack, trackCache } from '../db/schema.js';
import type { CatalogProvider } from '../catalog/provider.js';
import { ensureTrackCached } from '../catalog/assembly.js';
import { buildRoundChoices } from '../catalog/distractors.js';
import { newId } from '../ids.js';
import { apiError } from '../http.js';

type QuizRow = typeof quiz.$inferSelect;
type TrackCacheRow = typeof trackCache.$inferSelect;

function targetsFor(settings: Pick<QuizSettings, 'guessTarget'>): TargetName[] {
	if (settings.guessTarget === 'both') return ['title', 'artist'];
	return [settings.guessTarget];
}

/** Resolves every requested track, refusing the whole write at the first one that can't be added (MUS-5 at source, 1.10). */
async function resolveTracks(
	db: Db,
	provider: CatalogProvider,
	providerIds: readonly string[],
	opts: { fetchImpl?: typeof fetch } = {}
): Promise<TrackCacheRow[]> {
	const rows: TrackCacheRow[] = [];
	for (const id of providerIds) {
		const result = await ensureTrackCached(db, provider, id, opts);
		if (!result.ok) apiError('bad_request', result.message);
		rows.push(result.row as TrackCacheRow);
	}
	return rows;
}

async function buildChoicesByPosition(
	db: Db,
	provider: CatalogProvider,
	tracks: readonly TrackCacheRow[],
	settings: QuizSettings
): Promise<(RoundChoices | null)[]> {
	if (settings.answerMode !== 'choice') return tracks.map(() => null);
	const targets = targetsFor(settings);
	const out: (RoundChoices | null)[] = [];
	for (const row of tracks) out.push(await buildRoundChoices(db, row, targets, { provider }));
	return out;
}

async function replaceQuizTracks(
	db: Db,
	quizId: string,
	tracks: readonly TrackCacheRow[],
	choicesByPosition: readonly (RoundChoices | null)[]
): Promise<void> {
	await db.delete(quizTrack).where(eq(quizTrack.quizId, quizId));
	await db.insert(quizTrack).values(
		tracks.map((row, position) => ({
			quizId,
			position,
			trackId: row.id,
			choices: choicesByPosition[position]
		}))
	);
}

// ---------------------------------------------------------------------------
// CREATE-1/2 — manual creation
// ---------------------------------------------------------------------------

export async function createManualQuiz(
	db: Db,
	provider: CatalogProvider,
	ownerId: string,
	body: CreateQuizBody,
	now: number = Date.now(),
	opts: { fetchImpl?: typeof fetch } = {}
): Promise<{ quizId: string }> {
	const settings: QuizSettings = { ...DEFAULT_QUIZ_SETTINGS, ...body.settings };
	const tracks = await resolveTracks(db, provider, body.tracks, opts);
	const choicesByPosition = await buildChoicesByPosition(db, provider, tracks, settings);

	const quizId = newId();
	await db.insert(quiz).values({
		id: quizId,
		ownerId,
		kind: 'manual',
		name: body.name,
		description: body.description ?? null,
		guessTarget: settings.guessTarget,
		answerMode: settings.answerMode,
		scoringMode: settings.scoringMode,
		choiceRetryMode: settings.choiceRetryMode,
		choiceRetryPenaltySeconds: settings.choiceRetryPenaltySeconds,
		curveVersion: CURRENT_CURVE_VERSION,
		ephemeralUntil: null,
		createdAt: now,
		updatedAt: now
	});
	await replaceQuizTracks(db, quizId, tracks, choicesByPosition);

	return { quizId };
}

// ---------------------------------------------------------------------------
// Ownership + the CREATE-3 content-edit lock
// ---------------------------------------------------------------------------

/** 404/410/403, uniformly, for every write below. */
async function loadEditableQuiz(
	db: Db,
	quizId: string,
	userId: string,
	isOperator: boolean
): Promise<QuizRow> {
	const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!row) apiError('not_found', 'That quiz could not be found.');
	if (row.deletedAt !== null) apiError('gone', 'This quiz has been deleted.');

	const isOwner = row.ownerId === userId;
	const isOperatorCurated = row.ownerId === null && isOperator;
	if (!isOwner && !isOperatorCurated) {
		apiError('forbidden', "You don't have permission to edit this quiz.");
	}
	return row;
}

/** CREATE-3: content (settings/tracks) freezes the moment a quiz has been challenged or scored. */
async function hasBeenChallengedOrScored(db: Db, quizId: string): Promise<boolean> {
	const [challenged] = await db
		.select({ token: challenge.token })
		.from(challenge)
		.where(eq(challenge.quizId, quizId))
		.limit(1);
	if (challenged) return true;

	const [scored] = await db
		.select({ id: gameSession.id })
		.from(gameSession)
		.where(and(eq(gameSession.quizId, quizId), eq(gameSession.scored, true)))
		.limit(1);
	return Boolean(scored);
}

// ---------------------------------------------------------------------------
// CREATE-3 — patch (name/description always; content until frozen)
// ---------------------------------------------------------------------------

export async function patchQuiz(
	db: Db,
	provider: CatalogProvider,
	quizId: string,
	userId: string,
	isOperator: boolean,
	body: PatchQuizBody,
	now: number = Date.now(),
	opts: { fetchImpl?: typeof fetch } = {}
): Promise<void> {
	const row = await loadEditableQuiz(db, quizId, userId, isOperator);

	const wantsContentEdit = body.settings !== undefined || body.tracks !== undefined;
	if (wantsContentEdit && (await hasBeenChallengedOrScored(db, quizId))) {
		apiError(
			'conflict',
			'This quiz has already been challenged or scored, so its content is frozen. You can still rename it.'
		);
	}

	const settings: QuizSettings = {
		guessTarget: row.guessTarget,
		answerMode: row.answerMode,
		scoringMode: row.scoringMode,
		choiceRetryMode: row.choiceRetryMode,
		choiceRetryPenaltySeconds: row.choiceRetryPenaltySeconds,
		...body.settings
	};

	await db
		.update(quiz)
		.set({
			name: body.name ?? row.name,
			description: body.description !== undefined ? body.description : row.description,
			guessTarget: settings.guessTarget,
			answerMode: settings.answerMode,
			scoringMode: settings.scoringMode,
			choiceRetryMode: settings.choiceRetryMode,
			choiceRetryPenaltySeconds: settings.choiceRetryPenaltySeconds,
			updatedAt: now
		})
		.where(eq(quiz.id, quizId));

	if (body.tracks) {
		const tracks = await resolveTracks(db, provider, body.tracks, opts);
		const choicesByPosition = await buildChoicesByPosition(db, provider, tracks, settings);
		await replaceQuizTracks(db, quizId, tracks, choicesByPosition);
	} else if (body.settings?.answerMode && body.settings.answerMode !== row.answerMode) {
		// Answer mode flipped without a new track list: existing tracks need
		// their `choices` recomputed (choice→text clears them; text→choice builds
		// them) — same rows, so no delete/reinsert, just an update per row.
		const existing = await db
			.select({ trackId: quizTrack.trackId, position: quizTrack.position })
			.from(quizTrack)
			.where(eq(quizTrack.quizId, quizId))
			.orderBy(quizTrack.position);
		const trackRows = await db
			.select()
			.from(trackCache)
			.where(
				inArray(
					trackCache.id,
					existing.map((e) => e.trackId)
				)
			);
		const byId = new Map(trackRows.map((t) => [t.id, t]));
		const orderedTracks = existing.map((e) => byId.get(e.trackId)).filter((t) => t !== undefined);
		const choicesByPosition = await buildChoicesByPosition(db, provider, orderedTracks, settings);
		await replaceQuizTracks(db, quizId, orderedTracks, choicesByPosition);
	}
}

// ---------------------------------------------------------------------------
// CREATE-4 — soft delete
// ---------------------------------------------------------------------------

export async function deleteQuiz(
	db: Db,
	quizId: string,
	userId: string,
	isOperator: boolean,
	now: number = Date.now()
): Promise<void> {
	await loadEditableQuiz(db, quizId, userId, isOperator);
	await db.update(quiz).set({ deletedAt: now, updatedAt: now }).where(eq(quiz.id, quizId));
}

// ---------------------------------------------------------------------------
// CREATE-10 — duplicate
// ---------------------------------------------------------------------------

export async function duplicateQuiz(
	db: Db,
	quizId: string,
	ownerId: string,
	now: number = Date.now()
): Promise<{ quizId: string }> {
	const [source] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!source || source.deletedAt !== null) apiError('not_found', 'That quiz could not be found.');

	const sourceTracks = await db
		.select()
		.from(quizTrack)
		.where(eq(quizTrack.quizId, quizId))
		.orderBy(quizTrack.position);

	const newQuizId = newId();
	await db.insert(quiz).values({
		id: newQuizId,
		ownerId,
		kind: 'manual',
		name: `${source.name} (copy)`,
		description: source.description,
		guessTarget: source.guessTarget,
		answerMode: source.answerMode,
		scoringMode: source.scoringMode,
		choiceRetryMode: source.choiceRetryMode,
		choiceRetryPenaltySeconds: source.choiceRetryPenaltySeconds,
		curveVersion: CURRENT_CURVE_VERSION,
		ephemeralUntil: null,
		createdAt: now,
		updatedAt: now
	});
	await db.insert(quizTrack).values(
		sourceTracks.map((t) => ({
			quizId: newQuizId,
			position: t.position,
			trackId: t.trackId,
			choices: t.choices
		}))
	);

	return { quizId: newQuizId };
}

// ---------------------------------------------------------------------------
// CREATE-6 — save a generated quiz
// ---------------------------------------------------------------------------

export async function saveGeneratedQuiz(db: Db, quizId: string, ownerId: string): Promise<void> {
	const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!row || row.deletedAt !== null) apiError('not_found', 'That quiz could not be found.');
	if (row.kind !== 'generated') {
		apiError('bad_request', 'Only a generated quiz can be saved.');
	}
	if (row.ownerId !== null) {
		apiError('conflict', 'This quiz has already been saved.');
	}

	await db
		.update(quiz)
		.set({ ownerId, ephemeralUntil: null, updatedAt: Date.now() })
		.where(eq(quiz.id, quizId));
}

// ---------------------------------------------------------------------------
// Reads — §G-6: the endpoints the UI needs that §10's table didn't list.
// ---------------------------------------------------------------------------

export async function getQuizForLobby(db: Db, quizId: string) {
	const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!row) apiError('not_found', 'That quiz could not be found.');
	if (row.deletedAt !== null) apiError('gone', 'This quiz has been deleted by its creator.');

	const tracks = await db
		.select({ position: quizTrack.position })
		.from(quizTrack)
		.where(eq(quizTrack.quizId, quizId));

	return { quiz: row, roundCount: tracks.length };
}

export async function listMyQuizzes(db: Db, ownerId: string) {
	return db
		.select()
		.from(quiz)
		.where(and(eq(quiz.ownerId, ownerId), isNull(quiz.deletedAt)))
		.orderBy(desc(quiz.updatedAt));
}
