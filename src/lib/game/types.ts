/**
 * Shared game types — technical-spec §6, §7, §10.
 *
 * Pure and isomorphic: imported by both client and server. No I/O, no runtime
 * dependencies. Runtime validation of API boundaries lives in `schemas.ts`.
 */

import type { ScoringMode } from './scoring.js';

export type { ScoringMode };

// ---------------------------------------------------------------------------
// Catalog (§5.1)
// ---------------------------------------------------------------------------

export interface CreditedArtist {
	name: string;
	/** ANS-3: naming the primary artist suffices, featured artists are optional. */
	primary: boolean;
}

export interface CatalogTrack {
	providerId: string;
	title: string;
	/** Deezer's `title_short` — already drops most parenthetical noise. */
	titleShort: string;
	artists: CreditedArtist[];
	albumTitle: string;
	coverUrl: string | null;
	releaseYear: number | null;
	genre: string | null;
}

/** Precomputed accepted answers, stored as `track_cache.answers` (§5.4). */
export interface AnswerKey {
	title: string[];
	artist: string[];
}

/** Decade is derived, never stored (MUS-2). */
export function decadeOf(releaseYear: number | null): number | null {
	if (releaseYear === null || !Number.isFinite(releaseYear)) return null;
	return Math.floor(releaseYear / 10) * 10;
}

// ---------------------------------------------------------------------------
// Quiz (§6, QUIZ-1…6)
// ---------------------------------------------------------------------------

export type QuizKind = 'manual' | 'generated' | 'official' | 'daily';
export type GuessTarget = 'both' | 'title' | 'artist';
export type AnswerMode = 'text' | 'choice';
/** QUIZ-7: only meaningful when `answerMode === 'choice'` (ANS-7/8). */
export type ChoiceRetryMode = 'oneShot' | 'penalty';

export const MIN_ROUNDS = 5;
export const MAX_ROUNDS = 50;
export const DEFAULT_ROUNDS = 10;
/** Above this, MUS-7 requires an explicit size/time confirmation. */
export const PRELOAD_CONFIRM_THRESHOLD = 20;
/** DAILY-1: the daily is deliberately shorter — ~3 minutes a day. */
export const DAILY_ROUNDS = 5;

/** QUIZ-7/ANS-8 penalty-duration bounds. */
export const MIN_CHOICE_RETRY_PENALTY_SECONDS = 0;
export const MAX_CHOICE_RETRY_PENALTY_SECONDS = 10;
export const DEFAULT_CHOICE_RETRY_PENALTY_SECONDS = 3;

export interface QuizSettings {
	guessTarget: GuessTarget;
	answerMode: AnswerMode;
	scoringMode: ScoringMode;
	choiceRetryMode: ChoiceRetryMode;
	/** Seconds a wrong pick locks the target before a retry (ANS-8). Only used when `choiceRetryMode === 'penalty'`. */
	choiceRetryPenaltySeconds: number;
}

export const DEFAULT_QUIZ_SETTINGS: QuizSettings = {
	guessTarget: 'both',
	answerMode: 'text',
	scoringMode: 'speed',
	choiceRetryMode: 'oneShot',
	choiceRetryPenaltySeconds: DEFAULT_CHOICE_RETRY_PENALTY_SECONDS
};

export interface Quiz extends QuizSettings {
	id: string;
	ownerId: string | null;
	kind: QuizKind;
	name: string;
	description: string | null;
	curveVersion: number;
	/** Generated-but-unsaved TTL (CREATE-5/6); cleared on save or on use. */
	ephemeralUntil: number | null;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
}

export interface QuizTrack {
	quizId: string;
	position: number;
	providerId: string;
	/** 4 fixed options per target (ANS-6), null in free-text quizzes. */
	choices: RoundChoices | null;
}

export interface RoundChoices {
	title?: string[];
	artist?: string[];
}

/** CREATE-5 auto-generation filters. */
export interface GenerationFilters {
	decade?: number | null;
	genre?: string | null;
	/** Free-text seed: an artist ("Daft Punk") or a theme ("movie soundtracks"). */
	seed?: string | null;
	rounds: number;
	settings?: Partial<QuizSettings>;
}

// ---------------------------------------------------------------------------
// Session manifest (§7.1)
// ---------------------------------------------------------------------------

/**
 * One round as the client receives it. Deliberately carries **no** answer data
 * and no artwork or metadata (MUS-4) — reveal material lives encrypted in
 * `answerPack` and is opened only at reveal time.
 */
export interface ManifestRound {
	position: number;
	/** Freshly resolved, short-lived Deezer CDN URL (§5.2). Null ⇒ skipped (MUS-5). */
	previewUrl: string | null;
	skipped: boolean;
	choices: RoundChoices | null;
	/** AES-GCM blob; key = HKDF(sessionSeed, position), derived client-side (§7.2). */
	answerPack: string;
}

/** What lives inside a decrypted `answerPack` — accepted answers plus reveal data. */
export interface RoundPack {
	answers: AnswerKey;
	reveal: {
		title: string;
		artists: string[];
		albumTitle: string;
		coverUrl: string | null;
		releaseYear: number | null;
	};
}

export interface SessionManifest {
	sessionId: string;
	quizId: string;
	rounds: ManifestRound[];
	/** Round-key material for client-side HKDF (§7.2). */
	sessionSeed: string;
	settings: QuizSettings;
	/** Resolved once at creation, incl. the A11Y-5 extended-input override. */
	effectiveScoringMode: ScoringMode;
	curveVersion: number;
}

// ---------------------------------------------------------------------------
// Play-time records (§7.2, §6 `round_result`)
// ---------------------------------------------------------------------------

export type TargetName = 'title' | 'artist';

/** Every raw attempt, kept for server re-validation (§7.3 step 1). */
export interface GuessAttempt {
	target: TargetName;
	/** Raw player input, unnormalized — the server must do its own normalizing. */
	raw: string;
	/** Elapsed clip ms from the audio clock, not `Date.now()` (§4). */
	atMs: number;
}

export type GuessLog = GuessAttempt[];

export interface RoundResultPayload {
	position: number;
	guessLog: GuessLog;
	/** Elapsed clip ms at lock-in, per target. */
	lockTimes: Partial<Record<TargetName, number>>;
	/** Measured decoded-buffer duration — the curve's denominator (§9). */
	clipMs: number;
	skipped: boolean;
}

// ---------------------------------------------------------------------------
// Session outcome (§6, §7.3)
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'completed' | 'abandoned';

/**
 * Why a completed run did not post to a board (FAIR-6). Drives both the
 * player-facing message and the `/admin` flagged-sessions view (§15).
 *
 * `implausible` is never shown as an accusation — the player sees a generic
 * "couldn't be verified" (FAIR-4 posture).
 */
export type ScoredBlockReason =
	| 'replay'
	| 'creator'
	| 'clip_unavailable'
	| 'unverified_timing'
	| 'implausible'
	/**
	 * ROUND-8: the run sat `active` past the 2 h sweep and was presumed
	 * abandoned, but a finalize arrived for it anyway — the §4 "retry from
	 * localStorage on next visit" path, which can legitimately land days later.
	 *
	 * It exists because the two rules genuinely conflict: ROUND-8 says an
	 * abandoned run is discarded, MUS-7 says a finished run survives a dropped
	 * connection. Rejecting the finalize outright would lose a real player's
	 * result; accepting it onto the board would let anyone bank a session,
	 * research the answers at leisure, and finalize with plausible-looking lock
	 * times that no offline-survivable invariant can catch. So the player is
	 * shown their score and the board is not.
	 */
	| 'abandoned';

export interface FinalizedRound {
	position: number;
	titleOk: boolean | null;
	artistOk: boolean | null;
	skipped: boolean;
	clipMs: number;
	titleMs: number | null;
	artistMs: number | null;
	points: number;
}

export interface FinalizeResult {
	sessionId: string;
	totalScore: number;
	rounds: FinalizedRound[];
	scored: boolean;
	scoredBlockReason: ScoredBlockReason | null;
	effectiveScoringMode: ScoringMode;
	curveVersion: number;
	finalizedAt: number;
}

// ---------------------------------------------------------------------------
// Boards (§11)
// ---------------------------------------------------------------------------

export interface BoardEntry {
	rank: number;
	/** Display name or guest nickname (FAIR-3, FAIR-5). */
	name: string;
	totalScore: number;
	finalizedAt: number;
	isSelf: boolean;
	isFriend: boolean;
}

export interface Board {
	entries: BoardEntry[];
	/** The requesting player's own row, even when outside the top 50. */
	selfEntry: BoardEntry | null;
	mode: ScoringMode;
	/** A11Y-5: the Timed/Untimed toggle is shown only where the untimed board has entries. */
	hasUntimedEntries: boolean;
	nextCursor: string | null;
}
