import { type SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
	account,
	challenge,
	dailyGuestClaim,
	dailyQuiz,
	friendship,
	gameSession,
	importedHistory,
	metricsDaily,
	quiz,
	quizTrack,
	roundResult,
	session,
	shareEvent,
	trackCache,
	user,
	verification,
	weeklyPoints,
	weeklyRankSnapshot
} from './schema';

/** Every table in the model, listed explicitly so an omission is visible here. */
const ALL_TABLES: SQLiteTable[] = [
	user,
	session,
	account,
	verification,
	trackCache,
	quiz,
	quizTrack,
	dailyQuiz,
	challenge,
	gameSession,
	roundResult,
	friendship,
	weeklyPoints,
	weeklyRankSnapshot,
	dailyGuestClaim,
	importedHistory,
	metricsDaily,
	shareEvent
];

/**
 * Structural guards on the §6 data model. These are cheap and they catch the
 * class of mistake that only shows up in production: a dropped index turning a
 * board query into a table scan, or a column the spec requires quietly going
 * missing in a refactor.
 */

const columnNames = (table: SQLiteTable) => getTableConfig(table).columns.map((c) => c.name);

const indexNames = (table: SQLiteTable) => getTableConfig(table).indexes.map((i) => i.config.name);

describe('§6 — every table the spec requires exists', () => {
	it.each([
		// Better Auth (§12)
		'user',
		'session',
		'account',
		'verification',
		// Application tables (§6)
		'track_cache',
		'quiz',
		'quiz_track',
		'daily_quiz',
		'challenge',
		'game_session',
		'round_result',
		'friendship',
		'weekly_points',
		'daily_guest_claim',
		'metrics_daily',
		// Plan §G additions
		'imported_history',
		'share_event'
	])('%s', (tableName) => {
		expect(ALL_TABLES.map((t) => getTableConfig(t).name)).toContain(tableName);
	});
});

describe('§6 — the four board indexes exist (leaderboards are queries, not tables)', () => {
	it.each(['idx_gs_board', 'idx_gs_challenge', 'idx_gs_daily'])('%s', (name) => {
		expect(indexNames(gameSession)).toContain(name);
	});

	it('has a FAIR-2 first-run index for each identity kind', () => {
		expect(indexNames(gameSession)).toContain('idx_gs_player_user');
		expect(indexNames(gameSession)).toContain('idx_gs_player_guest');
	});

	it('segments every board index on effective_scoring_mode (A11Y-5 untimed board)', () => {
		const boardIndexes = getTableConfig(gameSession).indexes.filter((i) =>
			['idx_gs_board', 'idx_gs_challenge', 'idx_gs_daily'].includes(i.config.name)
		);
		expect(boardIndexes).toHaveLength(3);
		for (const idx of boardIndexes) {
			const cols = idx.config.columns.map((c) => ('name' in c ? c.name : ''));
			expect(cols, idx.config.name).toContain('effective_scoring_mode');
			expect(cols, idx.config.name).toContain('scored');
			// FAIR-3 tie-break is by earlier completion.
			expect(cols, idx.config.name).toContain('finalized_at');
		}
	});
});

describe('§G-15 — provider swap survivability', () => {
	it('keys track_cache on a namespaced id plus an explicit provider column', () => {
		const cols = columnNames(trackCache);
		expect(cols).toContain('provider');
		expect(cols).toContain('provider_track_id');
	});

	it('indexes (genre, decade) so §8.3 distractor pools come from cache, not live calls', () => {
		expect(indexNames(trackCache)).toContain('idx_track_genre_decade');
	});

	it('stores precomputed answers so play time never string-processes raw catalog data (§5.4)', () => {
		expect(columnNames(trackCache)).toContain('answers');
	});

	it('stores the known preview duration so finalize can bound a claimed clipMs (§7.3)', () => {
		expect(columnNames(trackCache)).toContain('preview_ms');
	});
});

describe('§6 — quiz lifecycle columns', () => {
	it('supports soft delete so dead links stay friendly (CREATE-4)', () => {
		expect(columnNames(quiz)).toContain('deleted_at');
	});

	it('carries the ephemeral TTL for generated quizzes (CREATE-5/6)', () => {
		expect(columnNames(quiz)).toContain('ephemeral_until');
	});

	it('stamps curve_version on the quiz so a board stays comparable for life (SCORE-6)', () => {
		expect(columnNames(quiz)).toContain('curve_version');
	});

	it('carries localized name/description columns for official and daily quizzes (LOC-3)', () => {
		const cols = columnNames(quiz);
		for (const c of ['name_fr', 'name_en', 'description_fr', 'description_en']) {
			expect(cols).toContain(c);
		}
	});

	it('fixes choices on quiz_track, not per session (QUIZ-6 fairness)', () => {
		expect(columnNames(quizTrack)).toContain('choices');
	});
});

describe('§6 — session and round columns the scoring authority depends on', () => {
	it('resolves effective_scoring_mode at creation (A11Y-5, §9)', () => {
		expect(columnNames(gameSession)).toContain('effective_scoring_mode');
	});

	it('records why a run did not post, for FAIR-6 and the /admin view', () => {
		expect(columnNames(gameSession)).toContain('scored_block_reason');
	});

	it('keeps server-observed beacon timestamps for the verified plausibility tier (§7.3)', () => {
		expect(columnNames(gameSession)).toContain('server_round_log');
	});

	it('keeps the measured clip duration as the curve denominator, per round (§9)', () => {
		expect(columnNames(roundResult)).toContain('clip_ms');
	});

	it('keeps every raw attempt so the server can recompute from scratch (§7.3 step 1)', () => {
		expect(columnNames(roundResult)).toContain('guess_log');
	});

	it('records a skipped round explicitly (MUS-5)', () => {
		expect(columnNames(roundResult)).toContain('skipped');
	});
});

describe('§16 — privacy-shaped columns', () => {
	it('collects birth year only, never a full date (LEGAL-1)', () => {
		const cols = columnNames(user);
		expect(cols).toContain('birth_year');
		expect(cols).not.toContain('birth_date');
		expect(cols).not.toContain('date_of_birth');
	});

	it('stores a normalized display name for case/diacritic-insensitive uniqueness (ACC-5)', () => {
		expect(columnNames(user)).toContain('display_name_normalized');
	});

	it('dedupes guests by a day-salted hash, never a raw IP (FAIR-7, §16)', () => {
		const cols = columnNames(dailyGuestClaim);
		expect(cols).toContain('ip_hash');
		expect(cols).not.toContain('ip');
		expect(cols).not.toContain('ip_address');
	});

	it('keeps metrics_daily to counts only — no player identifiers (MET-3)', () => {
		expect(columnNames(metricsDaily).sort()).toEqual(['day', 'metric', 'value']);
	});

	it('marks imported history so it can never reach a board (ACC-4, §G-3)', () => {
		expect(columnNames(importedHistory)).toContain('imported');
	});
});

describe('§6 — challenges are guest-creatable (CHAL-1)', () => {
	it('allows a guest nickname as the challenger identity', () => {
		const cols = columnNames(challenge);
		expect(cols).toContain('creator_user_id');
		expect(cols).toContain('creator_guest_nickname');
	});
});
