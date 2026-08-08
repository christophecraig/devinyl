/**
 * Deterministic local-D1 seed for the challenge-lobby e2e spec (plan task
 * 3.13's last open item, 4.12's §21 snapshot).
 *
 * Why a SQL seed at all: `(share)/c/[token]`'s `+page.server.ts` reads the
 * challenge from D1 **during SSR**, so a hard navigation exposes no
 * browser-visible request for `page.route` to intercept. The preview server
 * `playwright.config.ts` starts (`wrangler dev .svelte-kit/cloudflare/_worker.js`)
 * is a real Workers runtime over a real local D1 persisted under
 * `.wrangler/state/v3/d1` — the same store `wrangler d1 execute --local`
 * writes to — so the honest way to cover that page is to put real rows in it.
 * `e2e/global-setup.ts` applies the migrations and runs this SQL before the
 * suite starts.
 *
 * The row graph mirrors `src/lib/server/test-utils.integration.ts`
 * (`createQuiz`/`createGameSession`/`createRoundResult`) column for column, so
 * the seed cannot drift from the schema the server actually reads, and the
 * answer keys come from the app's own `buildAnswerKey` rather than a
 * hand-written list — the same source `e2e/helpers/manifest.ts` seals into the
 * manifest, which is what lets the *server's* finalize re-validation reproduce
 * the client's matches (§7.3 step 1).
 *
 * What it seeds:
 *   - four `track_cache` rows from `SHORT_QUIZ_TRACKS` (the committed 30 s
 *     tone WAVs' metadata; `preview_ms` = the real 30 000 ms duration, which
 *     finalize checks the client's measured `clipMs` against ±2 s);
 *   - a `quiz` + its four `quiz_track` rows;
 *   - a `challenge` row with a fixed token;
 *   - the challenger's finished, scored `game_session` + `round_result` rows,
 *     so the lobby renders a real "score to beat" (CHAL-1);
 *   - a second guest who has already accepted that challenge — a finished,
 *     scored session carrying the `challenge_token` — so the challenge board
 *     has a real rival row to land next to (§21). It has to be a *different*
 *     session from the challenger's: `createChallenge` builds a challenge
 *     *from* an existing run, so the challenger's own session carries no
 *     `challenge_token` and `boards.ts`'s challenge scope
 *     (`challenge_token = ?`) legitimately excludes it. The challenger's
 *     score reaches the visitor through the lobby banner, not the board;
 *   - an **active** `game_session` for the visiting guest, whose id the spec's
 *     mocked `POST /api/sessions` hands back as the manifest's `sessionId`.
 *     That is the seam that keeps the round beacons, the round results and
 *     finalize on the *real* server against real rows — see the spec's module
 *     doc for exactly which boundaries are real and which are mocked.
 *
 * Note on preview URLs: `track_cache` deliberately has **no** preview-URL
 * column (§7.1 — signed preview URLs expire, so they are resolved fresh per
 * session and never stored). The clip URLs the browser actually fetches come
 * from the manifest, which the spec builds with `e2e/helpers/manifest.ts`'s
 * `/e2e-clip/...` namespace and `mockClipRoutes` serves from
 * `e2e/fixtures/`. Audio never leaves the browser's control here; only the
 * SSR page load and the scoring path need real DB state.
 */

import { buildAnswerKey } from '../../src/lib/game/match.js';
import { SHORT_QUIZ_TRACKS, type FixtureTrack } from './tracks.js';

/** nanoid(10) shape (`challengeTokenSchema`), fixed so the spec can navigate straight to it. */
export const SEED_CHALLENGE_TOKEN = 'e2eChalTok';
/** nanoid(12) shape (`idSchema`) for every seeded id below. */
export const SEED_QUIZ_ID = 'e2eLobbyQuiz';
export const SEED_CHALLENGER_SESSION_ID = 'e2eChalgrSes';
export const SEED_RIVAL_SESSION_ID = 'e2eRivalSes1';
export const SEED_GUEST_SESSION_ID = 'e2eGuestSes1';
/** `guestIdSchema` (8–32 chars) — the spec pre-seeds this into `localStorage` so `x-guest-id` matches the seeded session's owner. */
export const SEED_GUEST_ID = 'e2eLobbyGuest01';

/** Who sent the link — surfaced by the lobby's SSR banner (CHAL-1), not by the challenge board. */
export const SEED_CHALLENGER_NICKNAME = 'Camille';
/** Someone who already took the challenge — the rival row on the challenge board (CHAL-2). */
export const SEED_RIVAL_NICKNAME = 'Léa';
/**
 * Both deliberately < 1000: the lobby and the board format scores through
 * `Intl.NumberFormat` (LOC-3), which inserts a group separator above that —
 * a narrow no-break space in French — and the assertions here would then be
 * comparing invisible characters rather than the thing under test.
 */
export const SEED_CHALLENGER_SCORE = 620;
export const SEED_RIVAL_SCORE = 480;

/** The nickname the visiting guest types; it must match the seeded session's, see the spec's module doc. */
export const SEED_GUEST_NICKNAME = 'Alex';

export const SEED_TRACKS: FixtureTrack[] = SHORT_QUIZ_TRACKS;

/** Real duration of the committed 30 s tone WAVs — `track_cache.preview_ms` (§7.3's ±2 s clip check). */
export const SEED_CLIP_MS = 30_000;

/** How far back the guest's session is started, so finalize's wall-clock invariant (§7.3 step 3) can never fail on a fast test run. */
const GUEST_SESSION_AGE_MS = 30 * 60_000;

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
	return sqlString(JSON.stringify(value));
}

function trackIdFor(index: number): string {
	// Namespaced key (§G-15), same `<provider>:<id>` shape `namespacedId()` builds.
	return `deezer:9900000${index}`;
}

function decadeOf(year: number | null): number | null {
	return year === null ? null : Math.floor(year / 10) * 10;
}

/**
 * The whole seed as one script: a targeted cleanup of everything a previous
 * run of this suite left behind (the local D1 file persists across runs, and
 * a stale scored session for the same guest would trip FAIR-2's replay block
 * on the next run), then the fixture rows.
 *
 * Only rows belonging to this fixture are deleted — the local database may
 * hold whatever else the developer has been doing, and a blanket wipe would
 * be a nasty surprise.
 */
export function buildSeedSql(now: number = Date.now()): string {
	const statements: string[] = [];
	const sessionIds = [SEED_CHALLENGER_SESSION_ID, SEED_RIVAL_SESSION_ID, SEED_GUEST_SESSION_ID]
		.map((id) => sqlString(id))
		.join(', ');
	const trackIds = SEED_TRACKS.map((_, index) => sqlString(trackIdFor(index))).join(', ');

	// --- cleanup: leaves before roots, D1 enforces the foreign keys ---
	statements.push(`DELETE FROM round_result WHERE session_id IN (${sessionIds});`);
	statements.push(
		`DELETE FROM game_session WHERE id IN (${sessionIds}) OR challenge_token = ${sqlString(SEED_CHALLENGE_TOKEN)} OR guest_id = ${sqlString(SEED_GUEST_ID)};`
	);
	statements.push(`DELETE FROM challenge WHERE token = ${sqlString(SEED_CHALLENGE_TOKEN)};`);
	statements.push(`DELETE FROM quiz_track WHERE quiz_id = ${sqlString(SEED_QUIZ_ID)};`);
	statements.push(`DELETE FROM quiz WHERE id = ${sqlString(SEED_QUIZ_ID)};`);
	statements.push(`DELETE FROM track_cache WHERE id IN (${trackIds});`);
	// Rate-limit counters are per-identity and windowed (`ratelimit.ts`): a
	// suite re-run inside the same minute must not 429 on session/finalize.
	statements.push(`DELETE FROM rate_limit;`);

	// --- track_cache (mirrors buildTrackCacheRow's columns) ---
	SEED_TRACKS.forEach((track, index) => {
		const answers = buildAnswerKey({ title: track.title, artists: track.artists });
		statements.push(
			`INSERT INTO track_cache (id, provider, provider_track_id, title, title_short, artists, album_title, cover_url, release_year, genre, decade, answers, preview_ms, fetched_at, unavailable_at) VALUES (${[
				sqlString(trackIdFor(index)),
				sqlString('deezer'),
				sqlString(`9900000${index}`),
				sqlString(track.title),
				sqlString(track.title),
				sqlJson(track.artists),
				sqlString(track.albumTitle),
				track.coverUrl === null ? 'NULL' : sqlString(track.coverUrl),
				track.releaseYear === null ? 'NULL' : String(track.releaseYear),
				sqlString('Chanson française'),
				String(decadeOf(track.releaseYear) ?? 'NULL'),
				sqlJson(answers),
				String(SEED_CLIP_MS),
				String(now),
				'NULL'
			].join(', ')});`
		);
	});

	// --- quiz + quiz_track (text mode, both targets, speed scoring) ---
	statements.push(
		`INSERT INTO quiz (id, owner_id, kind, name, description, guess_target, answer_mode, scoring_mode, choice_retry_mode, choice_retry_penalty_seconds, curve_version, ephemeral_until, created_at, updated_at, deleted_at) VALUES (${[
			sqlString(SEED_QUIZ_ID),
			'NULL',
			sqlString('manual'),
			sqlString('Chanson française'),
			'NULL',
			sqlString('both'),
			sqlString('text'),
			sqlString('speed'),
			sqlString('oneShot'),
			'3',
			'1',
			'NULL',
			String(now),
			String(now),
			'NULL'
		].join(', ')});`
	);
	SEED_TRACKS.forEach((_, position) => {
		statements.push(
			`INSERT INTO quiz_track (quiz_id, position, track_id, choices) VALUES (${sqlString(SEED_QUIZ_ID)}, ${position}, ${sqlString(trackIdFor(position))}, NULL);`
		);
	});

	// --- two finished runs: the challenger's (lobby banner) and an earlier
	//     challengee's (the board's rival row) ---
	const challengerFinalizedAt = now - 20 * 60_000;
	const rivalFinalizedAt = now - 10 * 60_000;

	function finishedSession(
		id: string,
		guestId: string,
		nickname: string,
		score: number,
		finalizedAt: number,
		challengeToken: string | null
	): void {
		statements.push(
			`INSERT INTO game_session (id, quiz_id, challenge_token, daily_day, user_id, guest_id, nickname, status, scored, scored_block_reason, curve_version, effective_scoring_mode, total_score, started_at, finalized_at, server_round_log) VALUES (${[
				sqlString(id),
				sqlString(SEED_QUIZ_ID),
				challengeToken === null ? 'NULL' : sqlString(challengeToken),
				'NULL',
				'NULL',
				sqlString(guestId),
				sqlString(nickname),
				sqlString('completed'),
				'1',
				'NULL',
				'1',
				sqlString('speed'),
				String(score),
				String(finalizedAt - 5 * 60_000),
				String(finalizedAt),
				sqlJson([])
			].join(', ')});`
		);
		SEED_TRACKS.forEach((_, position) => {
			statements.push(
				`INSERT INTO round_result (session_id, position, title_ok, artist_ok, skipped, clip_ms, title_ms, artist_ms, points, guess_log, claimed_title_ms, claimed_artist_ms, server_received_at) VALUES (${[
					sqlString(id),
					String(position),
					'1',
					'1',
					'0',
					String(SEED_CLIP_MS),
					'5000',
					'7000',
					String(Math.round(score / SEED_TRACKS.length)),
					sqlJson([]),
					'5000',
					'7000',
					String(finalizedAt)
				].join(', ')});`
			);
		});
	}

	// The challenge row first: `game_session.challenge_token` is a foreign key
	// into it, and D1 enforces foreign keys.
	statements.push(
		`INSERT INTO challenge (token, quiz_id, creator_user_id, creator_guest_nickname, creator_session_id, created_at) VALUES (${[
			sqlString(SEED_CHALLENGE_TOKEN),
			sqlString(SEED_QUIZ_ID),
			'NULL',
			sqlString(SEED_CHALLENGER_NICKNAME),
			sqlString(SEED_CHALLENGER_SESSION_ID),
			String(challengerFinalizedAt)
		].join(', ')});`
	);

	// The challenge is created *from* this run (`createChallenge`), so it
	// carries no `challenge_token` and never appears on the challenge board.
	finishedSession(
		SEED_CHALLENGER_SESSION_ID,
		'e2eChalgrGuest1',
		SEED_CHALLENGER_NICKNAME,
		SEED_CHALLENGER_SCORE,
		challengerFinalizedAt,
		null
	);
	// Someone who followed the same link earlier — a real row on the board.
	finishedSession(
		SEED_RIVAL_SESSION_ID,
		'e2eRivalGuest01',
		SEED_RIVAL_NICKNAME,
		SEED_RIVAL_SCORE,
		rivalFinalizedAt,
		SEED_CHALLENGE_TOKEN
	);

	// --- the visiting guest's session: active, waiting to be played for real ---
	statements.push(
		`INSERT INTO game_session (id, quiz_id, challenge_token, daily_day, user_id, guest_id, nickname, status, scored, scored_block_reason, curve_version, effective_scoring_mode, total_score, started_at, finalized_at, server_round_log) VALUES (${[
			sqlString(SEED_GUEST_SESSION_ID),
			sqlString(SEED_QUIZ_ID),
			sqlString(SEED_CHALLENGE_TOKEN),
			'NULL',
			'NULL',
			sqlString(SEED_GUEST_ID),
			sqlString(SEED_GUEST_NICKNAME),
			sqlString('active'),
			'0',
			'NULL',
			'1',
			sqlString('speed'),
			'NULL',
			String(now - GUEST_SESSION_AGE_MS),
			'NULL',
			sqlJson([])
		].join(', ')});`
	);

	return `${statements.join('\n')}\n`;
}
