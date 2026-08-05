/**
 * Daily quiz flow — DAILY-1/2/5, plan task 3.1/3.13.
 *
 * `(app)/daily` is client-fetched (`getDaily()` in `PlayQuiz`'s caller, see
 * that route's module doc) rather than SSR'd, so — unlike the challenge lobby
 * at `(share)/c/[token]` — its data call is a normal browser `fetch()` and
 * mocks cleanly with `page.route`, the same way `mock-api.ts` already does
 * for `/api/sessions`. That's what makes this flow coverable end-to-end
 * without a real D1-backed worker; the challenge lobby's SSR load is not, and
 * is intentionally left uncovered here — see `challenge-share.e2e.ts`'s
 * module doc for the boundary and why.
 */

import { expect, test } from '@playwright/test';
import type { DailyInfo } from '../src/lib/client/api.js';
import { SHORT_QUIZ_TRACKS } from './fixtures/tracks.js';
import { buildManifest } from './helpers/manifest.js';
import {
	mockClipRoutes,
	mockDailyApi,
	mockEmptyBoards,
	mockSessionApi
} from './helpers/mock-api.js';
import { clickContinue, clickNext, submitNickname, submitTextGuess } from './helpers/play-flow.js';

test('guest plays today’s daily quiz to the summary and can share the result', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eDailySession01',
		quizId: 'e2eDailyQuiz01',
		tracks: SHORT_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	const daily: DailyInfo = {
		day: '2026-08-05',
		dayNumber: 42,
		quizId: manifest.quizId,
		rounds: SHORT_QUIZ_TRACKS.length,
		isToday: true,
		alreadyPlayed: false
	};

	await mockDailyApi(page, { daily });
	const recorded = await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);
	await mockEmptyBoards(page);

	await page.goto('/daily');

	await expect(page.getByText('Devinyl #42')).toBeVisible();
	await expect(page.getByRole('heading', { name: "Today's quiz" })).toBeVisible();

	await submitNickname(page, 'Sonny');

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
	// DAILY-3: spoiler-free share is offered once the run is scored — never
	// clicked here (it opens the native share sheet / clipboard), just proven
	// reachable with the right day number wired through from `getDaily()`.
	await expect(page.getByRole('button', { name: 'Share result' })).toBeVisible();

	expect(recorded.finalizeBodies).toHaveLength(1);
	expect(recorded.finalizeBodies[0].rounds).toHaveLength(SHORT_QUIZ_TRACKS.length);
});

test('a daily already played today still renders with the replay notice', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eDailySession02',
		quizId: 'e2eDailyQuiz02',
		tracks: SHORT_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	const daily: DailyInfo = {
		day: '2026-08-05',
		dayNumber: 42,
		quizId: manifest.quizId,
		rounds: SHORT_QUIZ_TRACKS.length,
		isToday: true,
		alreadyPlayed: true
	};

	await mockDailyApi(page, { daily });
	await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/daily');

	await expect(page.getByRole('heading', { name: "Today's quiz" })).toBeVisible();
	await expect(
		page.getByText("You've already posted a scored run today — this replay won't count again.")
	).toBeVisible();
});
