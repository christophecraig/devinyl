/**
 * Drizzle schema — technical-spec §6, plus the gaps resolved in the plan's §G.
 *
 * D1 speaks SQLite, so this is the spec's schema verbatim in dialect terms; the
 * escape hatch back to better-sqlite3 on a VPS stays open (ADR-0002).
 *
 * Conventions from §6:
 *   - IDs are `nanoid(12)` strings unless noted.
 *   - Timestamps are integer Unix ms, UTC.
 *   - Migrations are additive-only between releases and applied in CI, never on boot.
 */

import { relations, sql } from 'drizzle-orm';
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

// ---------------------------------------------------------------------------
// Auth — owned by Better Auth (§6, §12). Shapes must track Better Auth's
// expectations; the app-specific columns are the ones at the bottom of `user`.
// ---------------------------------------------------------------------------

export const user = sqliteTable(
	'user',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		email: text('email').notNull(),
		emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
		image: text('image'),
		createdAt: integer('created_at').notNull().default(now),
		updatedAt: integer('updated_at').notNull().default(now),

		// --- app extensions (§6, ACC-5, LEGAL-1, A11Y-5, §15) ---
		displayName: text('display_name').notNull(),
		/**
		 * Normalized display name (§8.1 pipeline), stored so uniqueness is
		 * case- and diacritic-insensitive (ACC-5). Collisions get suffix suggestions.
		 */
		displayNameNormalized: text('display_name_normalized').notNull(),
		avatarUrl: text('avatar_url'),
		locale: text('locale', { enum: ['fr', 'en'] })
			.notNull()
			.default('fr'),
		/** LEGAL-1: 13+ enforced server-side at signup. Year only — a full date is more data than the check needs. */
		birthYear: integer('birth_year'),
		/**
		 * A11Y-5: forces `effective_scoring_mode = 'fixed'` for this player's runs.
		 * An accessibility preference, so treated as sensitive (§16): never exposed
		 * on a public surface, never in another player's export.
		 */
		extendedInput: integer('extended_input', { mode: 'boolean' }).notNull().default(false),
		/** §15 operator role — granted by a one-off script, gates `/admin` and CREATE-8/9. */
		isOperator: integer('is_operator', { mode: 'boolean' }).notNull().default(false),
		/**
		 * ACC-6 / §16: after deletion the email survives only as a salted hash for
		 * 30 days, to stop instant re-registration abuse. Then purged.
		 */
		deletedEmailHash: text('deleted_email_hash'),
		deletedEmailHashExpiresAt: integer('deleted_email_hash_expires_at')
	},
	(t) => [
		uniqueIndex('idx_user_email').on(t.email),
		uniqueIndex('idx_user_display_name_normalized').on(t.displayNameNormalized)
	]
);

export const session = sqliteTable(
	'session',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		token: text('token').notNull(),
		expiresAt: integer('expires_at').notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		createdAt: integer('created_at').notNull().default(now),
		updatedAt: integer('updated_at').notNull().default(now)
	},
	(t) => [uniqueIndex('idx_session_token').on(t.token), index('idx_session_user').on(t.userId)]
);

export const account = sqliteTable(
	'account',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accountId: text('account_id').notNull(),
		/** 'credential' for email+password, 'google' for OAuth. Apple deferred (ADR-0002). */
		providerId: text('provider_id').notNull(),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		accessTokenExpiresAt: integer('access_token_expires_at'),
		refreshTokenExpiresAt: integer('refresh_token_expires_at'),
		scope: text('scope'),
		idToken: text('id_token'),
		password: text('password'),
		createdAt: integer('created_at').notNull().default(now),
		updatedAt: integer('updated_at').notNull().default(now)
	},
	(t) => [
		index('idx_account_user').on(t.userId),
		uniqueIndex('idx_account_provider').on(t.providerId, t.accountId)
	]
);

export const verification = sqliteTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at').notNull(),
		createdAt: integer('created_at').notNull().default(now),
		updatedAt: integer('updated_at').notNull().default(now)
	},
	(t) => [index('idx_verification_identifier').on(t.identifier)]
);

// ---------------------------------------------------------------------------
// Catalog cache (§5.3, §5.4)
// ---------------------------------------------------------------------------

/**
 * Everything needed to run a quiz **without further catalog calls** (§5.3).
 * Playing a quiz costs one provider round-trip — the batch preview-URL
 * resolution at session start — regardless of player count.
 *
 * Keyed on a **namespaced** id (`deezer:3135556`), not a bare provider id: plan
 * §G-15. ADR-0001's ToS finding makes a provider swap plausible rather than
 * theoretical, and a bare key would orphan every quiz on the day we swap.
 */
export const trackCache = sqliteTable(
	'track_cache',
	{
		/** `<provider>:<providerTrackId>` — the stable key `quiz_track` references. */
		id: text('id').primaryKey(),
		provider: text('provider').notNull().default('deezer'),
		providerTrackId: text('provider_track_id').notNull(),

		title: text('title').notNull(),
		titleShort: text('title_short').notNull(),
		/** `[{ name, primary }]` — every credited artist (ANS-3). */
		artists: text('artists', { mode: 'json' })
			.notNull()
			.$type<{ name: string; primary: boolean }[]>(),
		albumTitle: text('album_title'),
		/**
		 * Cover URL is stored as a *reference only* and always fetched from the
		 * provider CDN at render time. ADR-0001: caching or proxying Deezer cover
		 * images is not permitted — text metadata caching is.
		 */
		coverUrl: text('cover_url'),
		releaseYear: integer('release_year'),
		genre: text('genre'),
		/** Derived from releaseYear at write time so `(genre, decade)` can be indexed (§8.3). */
		decade: integer('decade'),

		/** Precomputed accepted answers (§5.4): `{ title: string[], artist: string[] }`. */
		answers: text('answers', { mode: 'json' })
			.notNull()
			.$type<{ title: string[]; artist: string[] }>(),
		/** Known preview duration in ms — finalize checks the client's `clipMs` against it ±2 s (§7.3). */
		previewMs: integer('preview_ms'),

		fetchedAt: integer('fetched_at').notNull().default(now),
		/** Stamped by the availability re-check job on a takedown (§5.3, MUS-5). */
		unavailableAt: integer('unavailable_at')
	},
	(t) => [
		// §8.3 distractor pools are drawn from cache, not fetched live.
		index('idx_track_genre_decade').on(t.genre, t.decade),
		uniqueIndex('idx_track_provider').on(t.provider, t.providerTrackId)
	]
);

// ---------------------------------------------------------------------------
// Quiz (§6, QUIZ-1…6, CREATE-*)
// ---------------------------------------------------------------------------

export const quiz = sqliteTable(
	'quiz',
	{
		id: text('id').primaryKey(),
		/**
		 * NULL means "operator-owned" for official/daily, and "owner deleted their
		 * account" otherwise (§6, ACC-6). Officiality is decided by `kind`, never
		 * by a null owner.
		 */
		ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
		kind: text('kind', { enum: ['manual', 'generated', 'official', 'daily'] }).notNull(),

		name: text('name').notNull(),
		description: text('description'),
		// LOC-3 — localized columns, used for kind IN ('official','daily').
		nameFr: text('name_fr'),
		nameEn: text('name_en'),
		descriptionFr: text('description_fr'),
		descriptionEn: text('description_en'),

		guessTarget: text('guess_target', { enum: ['both', 'title', 'artist'] })
			.notNull()
			.default('both'),
		answerMode: text('answer_mode', { enum: ['text', 'choice'] })
			.notNull()
			.default('text'),
		scoringMode: text('scoring_mode', { enum: ['speed', 'fixed'] })
			.notNull()
			.default('speed'),
		/** SCORE-6 — stamped at creation, frozen for the quiz's lifetime. */
		curveVersion: integer('curve_version').notNull().default(1),

		/**
		 * Generated-but-unsaved TTL (CREATE-5/6). Cleared on save, and cleared
		 * unconditionally on *use* — creating a challenge or finalizing a scored
		 * session promotes the quiz, so a guest's challenge link cannot evaporate
		 * out from under its own board (§6).
		 */
		ephemeralUntil: integer('ephemeral_until'),

		createdAt: integer('created_at').notNull().default(now),
		updatedAt: integer('updated_at').notNull().default(now),
		/** CREATE-4 soft delete — links resolve to a friendly dead page, never a 404. */
		deletedAt: integer('deleted_at')
	},
	(t) => [
		index('idx_quiz_owner').on(t.ownerId),
		index('idx_quiz_kind').on(t.kind),
		index('idx_quiz_ephemeral').on(t.ephemeralUntil)
	]
);

export const quizTrack = sqliteTable(
	'quiz_track',
	{
		quizId: text('quiz_id')
			.notNull()
			.references(() => quiz.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		trackId: text('track_id')
			.notNull()
			.references(() => trackCache.id),
		/**
		 * 4 options per guess target, fixed at assembly (ANS-6, QUIZ-6). Content is
		 * frozen; only the *display order* is shuffled, per session, client-side.
		 */
		choices: text('choices', { mode: 'json' }).$type<{ title?: string[]; artist?: string[] }>()
	},
	(t) => [
		primaryKey({ columns: [t.quizId, t.position] }),
		index('idx_quiz_track_track').on(t.trackId)
	]
);

export const dailyQuiz = sqliteTable('daily_quiz', {
	/** Europe/Paris calendar day, `YYYY-MM-DD`. */
	day: text('day').primaryKey(),
	quizId: text('quiz_id')
		.notNull()
		.references(() => quiz.id),
	dayNumber: integer('day_number').notNull().unique()
});

export const challenge = sqliteTable(
	'challenge',
	{
		/** nanoid(10), unguessable (§6). */
		token: text('token').primaryKey(),
		quizId: text('quiz_id')
			.notNull()
			.references(() => quiz.id),
		/** Exactly one of these identifies the challenger — guests can challenge too (CHAL-1). */
		creatorUserId: text('creator_user_id').references(() => user.id, { onDelete: 'set null' }),
		creatorGuestNickname: text('creator_guest_nickname'),
		/** The score to beat, shown in the lobby and the unfurl (CHAL-1, SHARE-4). */
		creatorSessionId: text('creator_session_id'),
		createdAt: integer('created_at').notNull().default(now)
	},
	(t) => [index('idx_challenge_quiz').on(t.quizId)]
);

// ---------------------------------------------------------------------------
// Play (§6, §7.3, §11)
// ---------------------------------------------------------------------------

export const gameSession = sqliteTable(
	'game_session',
	{
		id: text('id').primaryKey(),
		quizId: text('quiz_id')
			.notNull()
			.references(() => quiz.id),
		challengeToken: text('challenge_token').references(() => challenge.token, {
			onDelete: 'set null'
		}),
		/** Set when this run is an attempt at a given day's daily (DAILY-2). */
		dailyDay: text('daily_day'),

		// Exactly one identity: a registered user, or a guest.
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		guestId: text('guest_id'),
		/** Display name or guest nickname, profanity-filtered at write (FAIR-5). */
		nickname: text('nickname').notNull(),

		status: text('status', { enum: ['active', 'completed', 'abandoned'] })
			.notNull()
			.default('active'),

		/** FAIR-2: first completed run for this player + quiz (+ challenge | daily). */
		scored: integer('scored', { mode: 'boolean' }).notNull().default(false),
		/** Drives both the player-facing message (FAIR-6) and the /admin view (§15). */
		scoredBlockReason: text('scored_block_reason', {
			enum: ['replay', 'creator', 'clip_unavailable', 'unverified_timing', 'implausible']
		}),

		curveVersion: integer('curve_version').notNull().default(1),
		/**
		 * Resolved **once at session creation**: the quiz's mode, forced to 'fixed'
		 * when the player has extendedInput (A11Y-5). Resolving it here rather than
		 * at finalize means the player is told which board they are on *before*
		 * they play. Boards segment on this column.
		 */
		effectiveScoringMode: text('effective_scoring_mode', { enum: ['speed', 'fixed'] }).notNull(),

		totalScore: integer('total_score'),
		startedAt: integer('started_at').notNull().default(now),
		finalizedAt: integer('finalized_at'),

		/** Server timestamps per round-start beacon — the verified plausibility tier (§7.3). */
		serverRoundLog: text('server_round_log', { mode: 'json' })
			.$type<{ position: number; at: number }[]>()
			.default([])
	},
	(t) => [
		// The four board indexes of §6. Each carries effective_scoring_mode so the
		// untimed board (A11Y-5) costs nothing until someone uses it.
		index('idx_gs_board').on(
			t.quizId,
			t.effectiveScoringMode,
			t.scored,
			t.totalScore,
			t.finalizedAt
		),
		index('idx_gs_challenge').on(
			t.challengeToken,
			t.effectiveScoringMode,
			t.scored,
			t.totalScore,
			t.finalizedAt
		),
		index('idx_gs_daily').on(
			t.dailyDay,
			t.effectiveScoringMode,
			t.scored,
			t.totalScore,
			t.finalizedAt
		),
		// FAIR-2 first-run checks, one per identity kind.
		index('idx_gs_player_user').on(t.userId, t.quizId),
		index('idx_gs_player_guest').on(t.guestId, t.quizId),
		// Abandoned-session sweep (ROUND-8, §15).
		index('idx_gs_status').on(t.status, t.startedAt)
	]
);

export const roundResult = sqliteTable(
	'round_result',
	{
		sessionId: text('session_id')
			.notNull()
			.references(() => gameSession.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		/** NULL where the target is not part of this quiz's guess_target. */
		titleOk: integer('title_ok', { mode: 'boolean' }),
		artistOk: integer('artist_ok', { mode: 'boolean' }),
		skipped: integer('skipped', { mode: 'boolean' }).notNull().default(false),
		/** Measured buffer duration — the curve's denominator, not a hardcoded 30 000 (§9). */
		clipMs: integer('clip_ms').notNull(),
		/** Elapsed clip time at lock-in. */
		titleMs: integer('title_ms'),
		artistMs: integer('artist_ms'),
		points: integer('points').notNull().default(0),
		/** Every raw attempt + timestamp, kept for server re-validation (§7.3 step 1). */
		guessLog: text('guess_log', { mode: 'json' })
			.$type<{ target: 'title' | 'artist'; raw: string; atMs: number }[]>()
			.notNull()
			.default([]),

		/**
		 * What the client *claimed*, kept separate from `title_ms`/`artist_ms`
		 * (which hold the server's own recomputation). Finalize cross-checks the
		 * two and notes disagreements for the /admin view (§7.3) — collapsing them
		 * into one column would make that check impossible after the fact.
		 */
		claimedTitleMs: integer('claimed_title_ms'),
		claimedArtistMs: integer('claimed_artist_ms'),
		/**
		 * Server receipt time of this round's result POST. Bounds the round in the
		 * verified plausibility tier when no later beacon arrived (§7.3 step 3).
		 */
		serverReceivedAt: integer('server_received_at')
	},
	(t) => [primaryKey({ columns: [t.sessionId, t.position] })]
);

// ---------------------------------------------------------------------------
// Social & ladder (§6, §11)
// ---------------------------------------------------------------------------

export const friendship = sqliteTable(
	'friendship',
	{
		/** Invariant: a_user_id < b_user_id, so a pair has exactly one row. */
		aUserId: text('a_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		bUserId: text('b_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		status: text('status', { enum: ['pending', 'accepted'] })
			.notNull()
			.default('pending'),
		requestedBy: text('requested_by')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at').notNull().default(now)
	},
	(t) => [
		primaryKey({ columns: [t.aUserId, t.bUserId] }),
		index('idx_friendship_b').on(t.bUserId, t.status)
	]
);

export const weeklyPoints = sqliteTable(
	'weekly_points',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** ISO week, Europe/Paris — e.g. `2026-W32`. Reset is implicit: a new week is a new key. */
		week: text('week').notNull(),
		points: integer('points').notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.week] }),
		index('idx_weekly_week').on(t.week, t.points)
	]
);

/** Best weekly rank, snapshotted Monday 00:05 before the old week goes cold (§11). */
export const weeklyRankSnapshot = sqliteTable(
	'weekly_rank_snapshot',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		week: text('week').notNull(),
		rank: integer('rank').notNull(),
		points: integer('points').notNull()
	},
	(t) => [primaryKey({ columns: [t.userId, t.week] })]
);

/**
 * FAIR-7 guest daily dedupe. `ipHash = HMAC(server_secret ‖ day, ip)` — day-salted,
 * so values are unlinkable across days (§16). Purged after 48 h (§15 sweep).
 * Coarse by design: it fails open toward letting people play.
 */
export const dailyGuestClaim = sqliteTable(
	'daily_guest_claim',
	{
		day: text('day').notNull(),
		ipHash: text('ip_hash').notNull(),
		guestId: text('guest_id').notNull(),
		createdAt: integer('created_at').notNull().default(now)
	},
	(t) => [primaryKey({ columns: [t.day, t.ipHash] }), index('idx_claim_created').on(t.createdAt)]
);

// ---------------------------------------------------------------------------
// Plan §G additions — gaps the spec left open
// ---------------------------------------------------------------------------

/**
 * ACC-4's local-only import (plan §G-3, task 1.8). Session-shaped rows that were
 * never server-validated: they feed STAT-1 and *best* streaks only, and never
 * enter any leaderboard. Kept in a separate table precisely so no board query
 * can reach them by accident.
 */
export const importedHistory = sqliteTable(
	'imported_history',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		quizId: text('quiz_id').references(() => quiz.id, { onDelete: 'set null' }),
		quizName: text('quiz_name'),
		totalScore: integer('total_score').notNull().default(0),
		rounds: integer('rounds').notNull().default(0),
		isDaily: integer('is_daily', { mode: 'boolean' }).notNull().default(false),
		playedAt: integer('played_at').notNull(),
		/** Always true — the column exists so the constraint is legible in the data itself. */
		imported: integer('imported', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at').notNull().default(now)
	},
	(t) => [index('idx_imported_user').on(t.userId, t.playedAt)]
);

/**
 * MET-1/3 aggregation (§15). **Counts only, never player identifiers** — that is
 * what lets measurement stay consistent with LEGAL-2 and MET-3.
 */
export const metricsDaily = sqliteTable(
	'metrics_daily',
	{
		day: text('day').notNull(),
		metric: text('metric').notNull(),
		value: integer('value').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.day, t.metric] })]
);

/**
 * Plan §G-2: MET-1 wants daily *share* counts and challenge *open* counts, and
 * nothing in the spec's tables records either. Anonymous counters — a token and a
 * kind, no identity, no IP.
 */
export const shareEvent = sqliteTable(
	'share_event',
	{
		day: text('day').notNull(),
		kind: text('kind', {
			enum: ['daily_share', 'challenge_open', 'quiz_open', 'invite_open']
		}).notNull(),
		count: integer('count').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.day, t.kind] })]
);

/**
 * Rate-limit counters (§10, task 1.18), fixed-window.
 *
 * Plan §G-10: the spec's token buckets assumed one long-lived Node process.
 * Workers isolates have no shared memory — two requests a millisecond apart can
 * land in different isolates — so the counter has to live somewhere both can
 * see. D1 is the only strongly-consistent store on the free tier.
 *
 * Fixed windows rather than sliding: one row and one upsert per request instead
 * of a row per request, which matters against the free tier's 100 k writes/day.
 * The cost is the usual fixed-window burst — up to 2× the limit across a window
 * boundary — which is irrelevant for limits whose job is to stop a script from
 * hammering Deezer, not to meter anything precisely.
 */
export const rateLimit = sqliteTable(
	'rate_limit',
	{
		/** `<bucket>:<identity>` — e.g. `session_create:guest_V1Std...`. */
		key: text('key').notNull(),
		/** Window start, Unix ms, floored to the window size. */
		windowStart: integer('window_start').notNull(),
		count: integer('count').notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.key, t.windowStart] }),
		// Swept by the 15-min job; without this the table only ever grows.
		index('idx_rate_limit_window').on(t.windowStart)
	]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const quizRelations = relations(quiz, ({ one, many }) => ({
	owner: one(user, { fields: [quiz.ownerId], references: [user.id] }),
	tracks: many(quizTrack),
	sessions: many(gameSession)
}));

export const quizTrackRelations = relations(quizTrack, ({ one }) => ({
	quiz: one(quiz, { fields: [quizTrack.quizId], references: [quiz.id] }),
	track: one(trackCache, { fields: [quizTrack.trackId], references: [trackCache.id] })
}));

export const gameSessionRelations = relations(gameSession, ({ one, many }) => ({
	quiz: one(quiz, { fields: [gameSession.quizId], references: [quiz.id] }),
	user: one(user, { fields: [gameSession.userId], references: [user.id] }),
	challenge: one(challenge, {
		fields: [gameSession.challengeToken],
		references: [challenge.token]
	}),
	rounds: many(roundResult)
}));

export const roundResultRelations = relations(roundResult, ({ one }) => ({
	session: one(gameSession, { fields: [roundResult.sessionId], references: [gameSession.id] })
}));
