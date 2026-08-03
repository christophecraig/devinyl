/**
 * Session creation and manifest assembly — technical-spec §7.1, plan task 1.14.
 *
 * The manifest is the single most security-relevant payload in the product, and
 * its defining property is negative: it contains **zero plaintext answer data**
 * (MUS-4). No title, no artist, no album, no artwork — those live inside the
 * per-round AES-GCM `answerPack`, whose key the client derives locally as
 * `HKDF(sessionSeed, n)` (`$lib/answerpack.ts`, §7.2). A player watching the
 * network tab sees round numbers, preview URLs, and opaque blobs.
 *
 * Two other §7.1 properties are load-bearing:
 *
 *   - **Preview URLs are resolved fresh, here, every time.** They carry a
 *     signed, time-limited token (§5.2) and are never stored — a cached URL is
 *     a dead clip an hour later.
 *   - **A dead preview does not fail the session.** The round is marked
 *     `skipped` in the manifest (MUS-5) and the run completes; finalize then
 *     blocks it from the boards with `clip_unavailable` (FAIR-6), because a
 *     player who never heard round 4 isn't comparable to one who did.
 */

import { asc, eq } from 'drizzle-orm';
import { sealRoundPack, generateSessionSeed } from '$lib/answerpack.js';
import type {
	ManifestRound,
	QuizSettings,
	RoundPack,
	ScoringMode,
	SessionManifest
} from '$lib/game/types.js';
import type { Db } from '../db/index.js';
import {
	challenge,
	dailyQuiz,
	gameSession,
	quiz,
	quizTrack,
	trackCache,
	user
} from '../db/schema.js';
import type { CatalogProvider } from '../catalog/provider.js';
import { apiError } from '../http.js';
import { newId } from '../ids.js';
import type { Player } from '../identity.js';
import { parisDay } from '../time.js';

type QuizRow = typeof quiz.$inferSelect;
type TrackRow = typeof trackCache.$inferSelect;

/** What is being played, resolved from the mutually-exclusive request fields. */
export type SessionTarget =
	{ kind: 'quiz'; quizId: string } | { kind: 'challenge'; token: string } | { kind: 'daily' };

export interface CreateSessionInput {
	target: SessionTarget;
	player: Player;
	nickname: string;
	now?: number;
}

/**
 * A11Y-5 / §9: a player using extended input plays on the untimed board, and
 * the decision is made **here, at creation**, not at finalize — so the pre-play
 * notice can tell them which board they're on before they commit three minutes
 * to it. Boards segment on the stored column, so it must be decided exactly
 * once per session.
 */
async function resolveScoringMode(db: Db, quizRow: QuizRow, player: Player): Promise<ScoringMode> {
	if (player.kind !== 'user') return quizRow.scoringMode;

	const [row] = await db
		.select({ extendedInput: user.extendedInput })
		.from(user)
		.where(eq(user.id, player.userId))
		.limit(1);

	return row?.extendedInput ? 'fixed' : quizRow.scoringMode;
}

interface ResolvedTarget {
	quizRow: QuizRow;
	challengeToken: string | null;
	dailyDay: string | null;
}

async function resolveTarget(db: Db, target: SessionTarget, now: number): Promise<ResolvedTarget> {
	if (target.kind === 'quiz') {
		return {
			quizRow: await loadPlayableQuiz(db, target.quizId),
			challengeToken: null,
			dailyDay: null
		};
	}

	if (target.kind === 'challenge') {
		const [row] = await db
			.select()
			.from(challenge)
			.where(eq(challenge.token, target.token))
			.limit(1);
		if (!row) apiError('not_found', 'This challenge link is no longer valid.');
		return {
			quizRow: await loadPlayableQuiz(db, row.quizId),
			challengeToken: row.token,
			dailyDay: null
		};
	}

	const day = parisDay(now);
	const [row] = await db.select().from(dailyQuiz).where(eq(dailyQuiz.day, day)).limit(1);
	if (!row) apiError('not_found', 'There is no quiz for today yet — check back shortly.');
	return { quizRow: await loadPlayableQuiz(db, row.quizId), challengeToken: null, dailyDay: day };
}

/** CREATE-4: a soft-deleted quiz is a friendly dead page (410), never a 404 that reads like a typo. */
async function loadPlayableQuiz(db: Db, quizId: string): Promise<QuizRow> {
	const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId)).limit(1);
	if (!row) apiError('not_found', 'That quiz could not be found.');
	if (row.deletedAt !== null) apiError('gone', 'This quiz has been deleted by its creator.');
	return row;
}

/**
 * Batch-resolve one fresh preview URL per round. Parallel because the whole set
 * gates the loading screen (MUS-7) and the provider's own throttle
 * (`catalog/throttle.ts`) is what keeps this inside §5.2's 50 req/5 s — adding
 * a second layer of sequencing here would just make the wait longer for no
 * additional safety.
 *
 * A rejection resolves to `null`, i.e. a skipped round, rather than failing the
 * whole session: one dead clip must not cost the player the other nine.
 */
async function resolvePreviewUrls(
	provider: CatalogProvider,
	tracks: TrackRow[]
): Promise<(string | null)[]> {
	const settled = await Promise.allSettled(
		tracks.map((track) =>
			track.unavailableAt !== null ? Promise.resolve(null) : provider.getPreviewUrl(track.id)
		)
	);
	return settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : null));
}

/** Everything the client needs at reveal (ROUND-4), sealed so it can't be read before then. */
function buildRoundPack(track: TrackRow): RoundPack {
	return {
		answers: track.answers,
		reveal: {
			title: track.title,
			artists: track.artists.map((a) => a.name),
			albumTitle: track.albumTitle ?? '',
			// A reference only — ADR-0001 forbids caching or proxying cover images,
			// so the client fetches this straight from the provider CDN at reveal.
			coverUrl: track.coverUrl,
			releaseYear: track.releaseYear
		}
	};
}

export async function createSession(
	db: Db,
	provider: CatalogProvider,
	input: CreateSessionInput
): Promise<SessionManifest> {
	const now = input.now ?? Date.now();
	const { quizRow, challengeToken, dailyDay } = await resolveTarget(db, input.target, now);

	const tracks = await db
		.select({ track: trackCache, choices: quizTrack.choices, position: quizTrack.position })
		.from(quizTrack)
		.innerJoin(trackCache, eq(quizTrack.trackId, trackCache.id))
		.where(eq(quizTrack.quizId, quizRow.id))
		.orderBy(asc(quizTrack.position));

	if (tracks.length === 0) {
		apiError('conflict', 'That quiz has no playable tracks.');
	}

	const previewUrls = await resolvePreviewUrls(
		provider,
		tracks.map((t) => t.track)
	);

	const sessionSeed = generateSessionSeed();
	const sessionId = newId();

	const rounds: ManifestRound[] = await Promise.all(
		tracks.map(async (row, index): Promise<ManifestRound> => {
			const previewUrl = previewUrls[index];
			return {
				position: row.position,
				previewUrl,
				skipped: previewUrl === null,
				// Choices are plaintext by design (ANS-6): four options leak nothing
				// about which one is right, and the client needs them to render.
				choices: row.choices ?? null,
				answerPack: await sealRoundPack(sessionSeed, row.position, buildRoundPack(row.track))
			};
		})
	);

	const settings: QuizSettings = {
		guessTarget: quizRow.guessTarget,
		answerMode: quizRow.answerMode,
		scoringMode: quizRow.scoringMode
	};
	const effectiveScoringMode = await resolveScoringMode(db, quizRow, input.player);

	await db.insert(gameSession).values({
		id: sessionId,
		quizId: quizRow.id,
		challengeToken,
		dailyDay,
		userId: input.player.userId,
		guestId: input.player.guestId,
		nickname: input.nickname,
		status: 'active',
		scored: false,
		curveVersion: quizRow.curveVersion,
		effectiveScoringMode,
		startedAt: now,
		serverRoundLog: []
	});

	return {
		sessionId,
		quizId: quizRow.id,
		rounds,
		sessionSeed,
		settings,
		effectiveScoringMode,
		curveVersion: quizRow.curveVersion
	};
}

/**
 * Load a session for the round/finalize endpoints, refusing anyone who isn't
 * the player who started it. Ownership is checked against the *stored* identity
 * rather than trusting the id in the URL: session ids are unguessable, but "the
 * id is secret" is not an authorization model.
 */
export async function loadOwnedSession(db: Db, sessionId: string, player: Player) {
	const [row] = await db.select().from(gameSession).where(eq(gameSession.id, sessionId)).limit(1);
	if (!row) apiError('not_found', 'That session could not be found.');

	const owned =
		player.kind === 'user' ? row.userId === player.userId : row.guestId === player.guestId;
	if (!owned) apiError('forbidden', 'That session belongs to another player.');

	return row;
}

/** Active sessions only — a finalized or swept run must not accept new rounds (ROUND-8). */
export async function loadActiveSession(db: Db, sessionId: string, player: Player) {
	const row = await loadOwnedSession(db, sessionId, player);
	if (row.status !== 'active') {
		apiError('conflict', 'That session is no longer active.');
	}
	return row;
}
