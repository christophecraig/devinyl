/**
 * Runtime validation for every API boundary — technical-spec §10.
 *
 * Shared: the server validates requests with these, and the client reuses them
 * to catch malformed payloads before they cost a round-trip. Kept beside the
 * types they mirror (`types.ts`) so the two cannot drift.
 *
 * Everything crossing the wire from a player is hostile until proven otherwise:
 * the server recomputes the entire session from these raw inputs (§7.3) and the
 * client's claimed correctness is never trusted.
 */

import { z } from 'zod';
import {
	DAILY_ROUNDS,
	MAX_ROUNDS,
	MIN_ROUNDS,
	MIN_CHOICE_RETRY_PENALTY_SECONDS,
	MAX_CHOICE_RETRY_PENALTY_SECONDS
} from './types.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** `nanoid(12)` application IDs (§6). */
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/, 'invalid id');

/** `nanoid(10)`, unguessable challenge tokens (§6). */
export const challengeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{10}$/, 'invalid token');

/** Namespaced catalog key, e.g. `deezer:3135556` (§G-15 — survives a provider swap). */
export const providerIdSchema = z
	.string()
	.regex(/^[a-z]+:[A-Za-z0-9._-]{1,64}$/, 'invalid provider id');

/** Client-generated guest identity, carried in the `x-guest-id` header (§4). */
export const guestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/, 'invalid guest id');

/**
 * A display name or guest nickname.
 *
 * Length and shape only — the profanity check (FAIR-5) is a separate server-side
 * step because it needs the curated lists, and it must run at *every* point a
 * name is set, not just where a schema happens to be applied.
 */
export const nicknameSchema = z
	.string()
	.trim()
	.min(2, 'too short')
	.max(24, 'too long')
	.regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u, 'invalid characters');

export const localeSchema = z.enum(['fr', 'en']);

/** Elapsed clip time in ms. Bounded well above any real preview so absurd values die at the boundary. */
const elapsedMsSchema = z.number().int().min(0).max(600_000);

// ---------------------------------------------------------------------------
// Quiz settings (QUIZ-2…5)
// ---------------------------------------------------------------------------

export const guessTargetSchema = z.enum(['both', 'title', 'artist']);
export const answerModeSchema = z.enum(['text', 'choice']);
export const scoringModeSchema = z.enum(['speed', 'fixed']);
export const choiceRetryModeSchema = z.enum(['oneShot', 'penalty']);
/** QUIZ-7/ANS-8: 0-10s, meaningful only when `choiceRetryMode === 'penalty'`. */
export const choiceRetryPenaltySecondsSchema = z
	.number()
	.int()
	.min(MIN_CHOICE_RETRY_PENALTY_SECONDS)
	.max(MAX_CHOICE_RETRY_PENALTY_SECONDS);

export const quizSettingsSchema = z.object({
	guessTarget: guessTargetSchema,
	answerMode: answerModeSchema,
	scoringMode: scoringModeSchema,
	choiceRetryMode: choiceRetryModeSchema,
	choiceRetryPenaltySeconds: choiceRetryPenaltySecondsSchema
});

export const roundCountSchema = z.number().int().min(MIN_ROUNDS).max(MAX_ROUNDS);

// ---------------------------------------------------------------------------
// Quiz creation & generation (§10 Quizzes)
// ---------------------------------------------------------------------------

export const quizNameSchema = z.string().trim().min(1).max(80);
export const quizDescriptionSchema = z.string().trim().max(500);

export const createQuizSchema = z.object({
	name: quizNameSchema,
	description: quizDescriptionSchema.nullish(),
	settings: quizSettingsSchema.partial().optional(),
	tracks: z.array(providerIdSchema).min(MIN_ROUNDS).max(MAX_ROUNDS)
});

/**
 * Name and description are always editable; **content edits are refused with 409
 * once the quiz has been challenged or scored** (CREATE-3). That check is a
 * server-side query, not something a schema can express — this schema only
 * describes the shape of what may be sent.
 */
export const patchQuizSchema = z
	.object({
		name: quizNameSchema.optional(),
		description: quizDescriptionSchema.nullish(),
		settings: quizSettingsSchema.partial().optional(),
		tracks: z.array(providerIdSchema).min(MIN_ROUNDS).max(MAX_ROUNDS).optional()
	})
	.refine((body) => Object.keys(body).length > 0, 'empty patch');

/**
 * CREATE-5 generation filters.
 *
 * `theme` is a key into a **curated, pre-vetted** theme list — not free text.
 * The Phase 0 probe measured raw theme search as unreliable (10/25 usable for
 * "comédie musicale française"), so v1 ships structured filters plus a fixed
 * set of themes rendered as choices (plan §G-8).
 */
export const generationFiltersSchema = z
	.object({
		decade: z
			.number()
			.int()
			.min(1950)
			.max(2030)
			.refine((d) => d % 10 === 0, 'decade must be a multiple of 10')
			.nullish(),
		genre: z.string().trim().min(1).max(40).nullish(),
		artist: z.string().trim().min(1).max(80).nullish(),
		theme: z.string().trim().min(1).max(40).nullish(),
		rounds: roundCountSchema,
		settings: quizSettingsSchema.partial().optional()
	})
	.refine(
		(f) => Boolean(f.decade || f.genre || f.artist || f.theme),
		'at least one filter is required'
	);

// ---------------------------------------------------------------------------
// Sessions (§7.1, §10 Sessions)
// ---------------------------------------------------------------------------

/**
 * Exactly one of quizId / challengeToken / daily identifies what is being played.
 * `nickname` is required for guests and profanity-checked server-side (FAIR-5,
 * §11 — the guest path is the one that reaches the public daily board).
 */
export const createSessionSchema = z
	.object({
		quizId: idSchema.optional(),
		challengeToken: challengeTokenSchema.optional(),
		daily: z.literal(true).optional(),
		nickname: nicknameSchema.optional()
	})
	.refine(
		(body) => [body.quizId, body.challengeToken, body.daily].filter(Boolean).length === 1,
		'exactly one of quizId, challengeToken or daily is required'
	);

export const guessAttemptSchema = z.object({
	target: z.enum(['title', 'artist']),
	/** Raw, unnormalized player input — the server does its own normalizing (§7.3 step 1). */
	raw: z.string().max(200),
	atMs: elapsedMsSchema
});

export const roundResultSchema = z
	.object({
		position: z
			.number()
			.int()
			.min(0)
			.max(MAX_ROUNDS - 1),
		guessLog: z.array(guessAttemptSchema).max(500),
		lockTimes: z
			.object({ title: elapsedMsSchema.optional(), artist: elapsedMsSchema.optional() })
			.default({}),
		/**
		 * Measured decoded-buffer duration. Re-checked server-side against the known
		 * preview duration (±2 s) so it cannot be inflated to buy a gentler curve
		 * (§7.3 step 3).
		 */
		clipMs: z.number().int().min(1_000).max(180_000),
		skipped: z.boolean().default(false),
		/** Beacons that failed during an offline stretch, flushed with the result (§4). */
		queuedBeacons: z
			.array(z.object({ position: z.number().int().min(0), atMs: z.number().int().min(0) }))
			.max(MAX_ROUNDS)
			.optional()
	})
	.refine(
		(r) => Object.values(r.lockTimes).every((t) => t === undefined || t <= r.clipMs),
		'a lock time cannot exceed the clip duration'
	)
	.refine((r) => !r.skipped || r.guessLog.length === 0, 'a skipped round cannot carry guesses');

export const finalizeSessionSchema = z.object({
	rounds: z.array(roundResultSchema).max(MAX_ROUNDS).optional()
});

// ---------------------------------------------------------------------------
// Challenges, social, profile (§10)
// ---------------------------------------------------------------------------

export const createChallengeSchema = z.object({
	sessionId: idSchema,
	nickname: nicknameSchema.optional()
});

export const catalogSearchSchema = z.object({
	q: z.string().trim().min(2).max(80)
});

export const boardQuerySchema = z.object({
	friends: z.coerce.boolean().default(false),
	mode: scoringModeSchema.optional(),
	cursor: z.string().max(120).optional(),
	limit: z.coerce.number().int().min(1).max(50).default(50)
});

export const updateSettingsSchema = z
	.object({
		locale: localeSchema.optional(),
		/** A11Y-5: forces fixed scoring for this player's runs, on the untimed board. */
		extendedInput: z.boolean().optional(),
		displayName: nicknameSchema.optional()
	})
	.refine((body) => Object.keys(body).length > 0, 'empty patch');

/** LEGAL-1: 13+ self-declared, year only — a full date is more personal data than the check needs. */
export const signupExtrasSchema = z.object({
	displayName: nicknameSchema,
	birthYear: z.number().int().min(1900).max(new Date().getFullYear()),
	locale: localeSchema.optional()
});

/** ACC-4 guest import: the local blob plus the guestId whose server rows are re-attributed. */
export const importGuestSchema = z.object({
	guestId: guestIdSchema,
	history: z
		.array(
			z.object({
				quizId: idSchema.optional(),
				quizName: z.string().max(80).optional(),
				totalScore: z.number().int().min(0).max(1_000_000),
				rounds: z.number().int().min(0).max(MAX_ROUNDS),
				playedAt: z.number().int().min(0),
				isDaily: z.boolean().default(false)
			})
		)
		.max(1000)
		.default([])
});

export const dailyRoundCountSchema = z.literal(DAILY_ROUNDS);

// ---------------------------------------------------------------------------
// Inferred types — the wire contract, derived from the schemas rather than
// declared twice.
// ---------------------------------------------------------------------------

export type CreateQuizBody = z.infer<typeof createQuizSchema>;
export type PatchQuizBody = z.infer<typeof patchQuizSchema>;
export type GenerationFiltersBody = z.infer<typeof generationFiltersSchema>;
export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type RoundResultBody = z.infer<typeof roundResultSchema>;
export type FinalizeSessionBody = z.infer<typeof finalizeSessionSchema>;
export type ImportGuestBody = z.infer<typeof importGuestSchema>;
export type BoardQuery = z.infer<typeof boardQuerySchema>;
