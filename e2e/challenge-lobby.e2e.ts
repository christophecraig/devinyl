/**
 * A stranger opens a real challenge link — the §21 acceptance snapshot,
 * closing plan task 3.13's last open E2E item (and 4.12's "§21 verbatim").
 *
 * `challenge-share.e2e.ts` covers the first half of the loop (a finished run
 * creating a link). This is the second half, the one a browser-level mock
 * could not reach: `(share)/c/[token]`'s `+page.server.ts` reads the
 * challenge **from D1 during SSR**, so a hard navigation exposes no request
 * for `page.route` to intercept. `e2e/global-setup.ts` therefore seeds the
 * real local D1 that the `wrangler dev` preview server reads
 * (`e2e/fixtures/challenge-seed.ts`) instead of faking the page.
 *
 * ## Real vs mocked, precisely
 *
 * REAL (the point of this spec — a real Workers runtime over real D1 rows):
 *   - the lobby's SSR render at `/c/<token>`: challenger nickname, score to
 *     beat and round count all come out of `loadChallengeLobby`'s D1 reads
 *     (CHAL-1), in the response HTML, on a cold hard navigation;
 *   - the round-start beacons and round results (`POST
 *     /api/sessions/:id/rounds/:n/{start,result}`) — real rows, real
 *     `server_round_log`;
 *   - **finalize** (`POST /api/sessions/:id/finalize`): the server re-runs
 *     `normalize`/`match` over the raw typo'd guess log against the seeded
 *     `track_cache.answers`, re-derives the score from the client's claimed
 *     lock times, and runs the §7.3 plausibility tiers and FAIR-1/2 blocks.
 *     The score on the summary is the server's, not a canned number;
 *   - the challenge board (`GET /api/challenges/:token/board`, CHAL-2): a
 *     real `boards.ts` query, returning the seeded rival's row *and* the row
 *     this run just wrote — §21's "next to their friend's score";
 *   - the FR/EN locale (LOC-1): the second test renders the same lobby in
 *     French from the `PARAGLIDE_LOCALE` cookie alone, SSR'd.
 *
 * MOCKED (unchanged from the rest of the suite, and unavoidable here):
 *   - `POST /api/sessions`, which returns the sealed `SessionManifest`. The
 *     real one resolves a **fresh preview URL per round from Deezer** (§7.1 —
 *     signed and short-lived, which is why `track_cache` stores no URL), a
 *     server-side fetch no browser-level mock can intercept and a live
 *     third-party dependency no test should take on. The mock answers with a
 *     manifest whose `sessionId` is the seeded *active* `game_session`, so
 *     everything downstream of it stays real;
 *   - the clip audio itself: the manifest points at `/e2e-clip/...`, served
 *     from the committed tone WAVs by `mockClipRoutes` (task 1.29).
 *
 * One consequence of that seam is worth naming: because session creation is
 * mocked, the nickname typed into the prompt never reaches the server, so the
 * board shows the seeded session's `nickname` column. The seed and the test
 * therefore agree on `SEED_GUEST_NICKNAME` — the nickname prompt is still
 * exercised as §21 requires, but the board's name string is the seeded one.
 */

import { expect, test, type Page } from '@playwright/test';
import { buildAnswerKey, match } from '../src/lib/game/match.js';
import {
	SEED_CHALLENGE_TOKEN,
	SEED_CHALLENGER_NICKNAME,
	SEED_CHALLENGER_SCORE,
	SEED_GUEST_ID,
	SEED_GUEST_NICKNAME,
	SEED_GUEST_SESSION_ID,
	SEED_QUIZ_ID,
	SEED_RIVAL_NICKNAME,
	SEED_RIVAL_SCORE,
	SEED_TRACKS
} from './fixtures/challenge-seed.js';
import type { FixtureTrack } from './fixtures/tracks.js';
import { buildManifest } from './helpers/manifest.js';
import { mockClipRoutes } from './helpers/mock-api.js';
import {
	clickContinue,
	clickNext,
	startFromPreloadGate,
	submitNickname,
	submitTextGuess
} from './helpers/play-flow.js';
import { transposedTypo } from './helpers/typos.js';

/** Same self-verified typo strategy as `solo-happy-path.e2e.ts` — a real accepted transposition where the answer is long enough to tolerate one. */
function typedGuessFor(track: FixtureTrack): { title: string; artist: string } {
	const answers = buildAnswerKey({ title: track.title, artists: track.artists });
	const primaryArtist = track.artists[0].name;
	const title = transposedTypo(track.title) ?? track.title;
	const artist = transposedTypo(primaryArtist) ?? primaryArtist;

	expect(match(title, answers.title), `expected "${title}" to match ${track.title}`).toBe(true);
	expect(match(artist, answers.artist), `expected "${artist}" to match ${primaryArtist}`).toBe(
		true
	);
	return { title, artist };
}

/**
 * Pins the guest identity `x-guest-id` will carry, so the real server
 * recognizes this browser as the owner of the seeded active session
 * (`loadOwnedSession`). Shape must satisfy `parseStoredGuest` in
 * `src/lib/client/guest.ts` or it is discarded and a random id is minted.
 * `nickname: null` keeps the §21 nickname prompt in the flow.
 */
async function seedGuestIdentity(page: Page): Promise<void> {
	await page.addInitScript((guestId: string) => {
		localStorage.setItem(
			'devinyl:guest:v1',
			JSON.stringify({
				schemaVersion: 1,
				guestId,
				nickname: null,
				history: [],
				dailyStreak: { count: 0, lastDay: null }
			})
		);
	}, SEED_GUEST_ID);
}

test('a stranger opens a real challenge link, plays it, and lands on the board next to their friend', async ({
	page
}) => {
	await seedGuestIdentity(page);
	const manifest = await buildManifest({
		sessionId: SEED_GUEST_SESSION_ID,
		quizId: SEED_QUIZ_ID,
		tracks: SEED_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	// The *only* API mock in this spec — see module doc for why it cannot be real.
	await page.route('**/api/sessions', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify(manifest)
		});
	});
	await mockClipRoutes(page);

	// A cold hard navigation to the shared link: everything below the fold of
	// this assertion was rendered on the server, out of D1.
	const response = await page.goto(`/c/${SEED_CHALLENGE_TOKEN}`);
	expect(response?.status()).toBe(200);
	expect(await response!.text()).toContain(`${SEED_CHALLENGER_NICKNAME} challenges you`);

	await expect(
		page.getByRole('heading', { name: `${SEED_CHALLENGER_NICKNAME} challenges you` })
	).toBeVisible();
	await expect(page.getByText(`Score to beat: ${SEED_CHALLENGER_SCORE} pts`)).toBeVisible();
	await expect(page.getByText(`${SEED_TRACKS.length} rounds`)).toBeVisible();

	// No account, ever (§21): a nickname is the whole of the sign-up.
	await submitNickname(page, SEED_GUEST_NICKNAME);
	await startFromPreloadGate(page);

	for (const [index, track] of SEED_TRACKS.entries()) {
		const guess = typedGuessFor(track);

		await expect(
			page.getByRole('heading', { name: `Round ${index + 1} of ${SEED_TRACKS.length}` })
		).toBeVisible();

		await submitTextGuess(page, 'Title', guess.title);
		await expect(page.locator('#text-answer-status-title')).toHaveText('Locked in');
		await submitTextGuess(page, 'Artist', guess.artist);

		// The reveal after each round (§21), straight after the second lock (ROUND-3).
		await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible();
		await expect(page.getByText(track.title, { exact: true })).toBeVisible();
		await expect(page.getByText(/correct, \+\d+ pts/)).toHaveCount(2);

		await clickNext(page);
		await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();
		await clickContinue(page);
	}

	await expect(page.getByRole('heading', { name: 'Quiz complete' })).toBeVisible();

	// The board is a real `GET /api/challenges/:token/board` against real D1:
	// the seeded row of the friend who took this challenge earlier, and the row
	// this run's real finalize just wrote. Both rows together is §21's "next to
	// their friend's score". (The *challenger's* own run is not on this board —
	// see the seed's module doc; their score reaches the visitor through the
	// lobby banner asserted above.)
	const board = page.locator('.board-preview');
	await expect(board).toBeVisible();
	await expect(board.getByText(SEED_RIVAL_NICKNAME, { exact: true })).toBeVisible();
	await expect(board.getByText(String(SEED_RIVAL_SCORE), { exact: true })).toBeVisible();
	const ownRow = board.locator('li.self');
	await expect(ownRow).toHaveCount(1);
	await expect(ownRow).toContainText(SEED_GUEST_NICKNAME);
});

test('the same challenge lobby renders in French from the locale cookie alone', async ({
	browser,
	baseURL
}) => {
	// A fresh context, so this is a genuinely first-time visitor whose only
	// state is the locale cookie — LOC-1's "URL-independent" claim, SSR'd.
	const context = await browser.newContext();
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: baseURL! }]);
	const page = await context.newPage();

	const response = await page.goto(`/c/${SEED_CHALLENGE_TOKEN}`);
	expect(await response!.text()).toContain(`${SEED_CHALLENGER_NICKNAME} te défie`);

	await expect(
		page.getByRole('heading', { name: `${SEED_CHALLENGER_NICKNAME} te défie` })
	).toBeVisible();
	await expect(page.getByText(`Score à battre : ${SEED_CHALLENGER_SCORE} pts`)).toBeVisible();
	await expect(page.getByText(`${SEED_TRACKS.length} manches`)).toBeVisible();

	await context.close();
});
