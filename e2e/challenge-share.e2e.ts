/**
 * Guest-to-guest challenge flow — CHAL-1…4, plan task 3.5/3.13.
 *
 * Covers the half of the flow a browser-level mock can reach: a guest plays
 * a quiz to the summary and creates a challenge link (`POST /api/challenges`,
 * a plain client `fetch()` from `ChallengeShare.svelte` — mocks exactly like
 * `/api/sessions` does in `mock-api.ts`).
 *
 * What this deliberately does NOT cover: a second guest opening that link at
 * `(share)/c/[token]`. That route's `+page.server.ts` reads the challenge
 * straight from D1 during SSR (`loadChallengeLobby`) — there is no
 * browser-visible request for `page.route` to intercept on a hard
 * navigation, so faking it would mean either standing up real D1 seeding
 * against the `wrangler dev` preview server or adding a test-only backdoor
 * route to production code. Neither was taken on for this pass (see the
 * 3.13 gap note in `docs/implementation-plan.md`) — the lobby's real-DB
 * render stays a documented gap, not a blocker.
 */

import { expect, test } from '@playwright/test';
import { SHORT_QUIZ_TRACKS } from './fixtures/tracks.js';
import { buildManifest } from './helpers/manifest.js';
import {
	mockClipRoutes,
	mockCreateChallenge,
	mockEmptyBoards,
	mockSessionApi
} from './helpers/mock-api.js';
import {
	clickContinue,
	clickNext,
	submitGenerateForm,
	submitNickname,
	submitTextGuess
} from './helpers/play-flow.js';

test('a finished run can create and display a challenge link', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eChallengeSession01',
		quizId: 'e2eChallengeQuiz01',
		tracks: SHORT_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	const recorded = await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);
	await mockEmptyBoards(page);
	const challengeToken = 'e2eChallengeToken01';
	const challengeCalls = mockCreateChallenge(page, { token: challengeToken });

	await page.goto('/');
	await submitNickname(page, 'Sonny');
	await submitGenerateForm(page, 'Stromae');

	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	await page.getByRole('button', { name: 'Start quiz' }).click();

	for (const [index, track] of SHORT_QUIZ_TRACKS.entries()) {
		await expect(
			page.getByRole('heading', { name: `Round ${index + 1} of ${SHORT_QUIZ_TRACKS.length}` })
		).toBeVisible();

		await submitTextGuess(page, 'Title', track.title);
		await submitTextGuess(page, 'Artist', track.artists[0].name);

		await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible();
		await clickNext(page);
		await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();
		await clickContinue(page);
	}

	await expect(page.getByRole('heading', { name: 'Quiz complete' })).toBeVisible();

	await page.getByRole('button', { name: 'Challenge a friend' }).click();
	await expect(page.getByRole('button', { name: 'Share challenge link' })).toBeVisible();

	const linkField = page.getByLabel('Challenge link');
	await expect(linkField).toHaveValue(new RegExp(`/c/${challengeToken}$`));

	// CHAL-1: the challenge is created from the finalized session, and only
	// after that finalize actually landed.
	expect(recorded.finalizeBodies).toHaveLength(1);
	expect(challengeCalls.sessionIds).toEqual([manifest.sessionId]);
});
