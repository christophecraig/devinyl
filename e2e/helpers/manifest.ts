/**
 * Builds a real `SessionManifest` for the mocked `POST /api/sessions`
 * response — plan task 1.30's "hard part" (see the task brief): the
 * manifest's `answerPack` blobs are real AES-GCM, sealed with the actual
 * `sealRoundPack`/HKDF code path (`src/lib/answerpack.ts`), so the client's
 * real `openRoundPack()` can decrypt them. A hand-written blob would fail the
 * test for the wrong reason (a decrypt error, not a gameplay assertion).
 *
 * Importing from `src/lib` is fine — task 1.30 only forbids *editing*
 * anything under `src/`.
 */

import { sealRoundPack, generateSessionSeed } from '../../src/lib/answerpack.js';
import { buildAnswerKey } from '../../src/lib/game/match.js';
import { CURRENT_CURVE_VERSION } from '../../src/lib/game/scoring.js';
import type {
	ManifestRound,
	QuizSettings,
	RoundChoices,
	RoundPack,
	SessionManifest
} from '../../src/lib/game/types.js';
import type { FixtureTrack } from '../fixtures/tracks.js';

/**
 * Namespace for the fake clip URLs, distinct from any real app route —
 * `e2e/helpers/mock-api.ts` intercepts this prefix and serves the committed
 * tone WAVs (task 1.29) instead of ever reaching Deezer.
 */
export const CLIP_ROUTE_PREFIX = '/e2e-clip';

export function clipUrlFor(track: FixtureTrack, position: number): string {
	// `position` keeps the URL unique per round even when two rounds reuse the
	// same tone file, which matters for asserting "this round's fetch" in
	// tests that inspect network activity.
	return `${CLIP_ROUTE_PREFIX}/${position}-${track.clipFile}`;
}

export interface BuildManifestOptions {
	sessionId: string;
	quizId: string;
	tracks: FixtureTrack[];
	settings: QuizSettings;
	/** Choice-mode distractors (ANS-6/7). Omitted rounds get `choices: null` (free-text). */
	choicesFor?: (track: FixtureTrack, position: number, all: FixtureTrack[]) => RoundChoices;
}

/** Mirrors `buildRoundPack()` in `src/lib/server/sessions/create.ts` (not exported there). */
function buildRoundPack(track: FixtureTrack): RoundPack {
	return {
		answers: buildAnswerKey({ title: track.title, artists: track.artists }),
		reveal: {
			title: track.title,
			artists: track.artists.map((a) => a.name),
			albumTitle: track.albumTitle,
			coverUrl: track.coverUrl,
			releaseYear: track.releaseYear
		}
	};
}

export async function buildManifest(opts: BuildManifestOptions): Promise<SessionManifest> {
	const sessionSeed = generateSessionSeed();

	const rounds: ManifestRound[] = await Promise.all(
		opts.tracks.map(async (track, position): Promise<ManifestRound> => {
			const pack = buildRoundPack(track);
			return {
				position,
				previewUrl: clipUrlFor(track, position),
				skipped: false,
				choices: opts.choicesFor ? opts.choicesFor(track, position, opts.tracks) : null,
				answerPack: await sealRoundPack(sessionSeed, position, pack)
			};
		})
	);

	return {
		sessionId: opts.sessionId,
		quizId: opts.quizId,
		rounds,
		sessionSeed,
		settings: opts.settings,
		// No extended-input override in these tests (that's Phase 2/A11Y-5) —
		// effective mode is always just the quiz's own setting.
		effectiveScoringMode: opts.settings.scoringMode,
		curveVersion: CURRENT_CURVE_VERSION
	};
}

/**
 * Four plaintext options per target (ANS-6): the round's own correct answer
 * plus three distractors pulled from the other tracks in the deck. Requires
 * at least 4 tracks in `all`.
 */
export function choicesFromDeck(
	track: FixtureTrack,
	position: number,
	all: FixtureTrack[]
): RoundChoices {
	if (all.length < 4) {
		throw new Error('choicesFromDeck needs at least 4 tracks to build distractors');
	}
	const others = all.filter((t) => t !== track);

	function fourOptions(correct: string, pool: string[]): string[] {
		const distractors = pool.filter((v) => v !== correct).slice(0, 3);
		const options = [correct, ...distractors];
		// Deterministic order here is fine — ChoiceAnswer.svelte re-shuffles
		// with seededShuffle(sessionId, position, target) before rendering.
		return options;
	}

	return {
		title: fourOptions(
			track.title,
			others.map((t) => t.title)
		),
		artist: fourOptions(
			track.artists[0].name,
			others.map((t) => t.artists[0].name)
		)
	};
}
