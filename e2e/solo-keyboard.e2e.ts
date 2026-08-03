/**
 * Keyboard-only full-quiz run — A11Y-6, plan task 1.30.
 *
 * The same solo flow as `solo-happy-path.e2e.ts`, but driven entirely through
 * `page.keyboard` (Tab to move focus, type to fill fields, Enter to submit)
 * via `e2e/helpers/keyboard-flow.ts`. No `.click()`, `.focus()`, or
 * `.selectOption()` anywhere in this file — that is the whole point of the
 * test, so pulling in the pointer-driven `play-flow.ts` helpers here would
 * quietly defeat it.
 */

import { expect, test } from '@playwright/test';
import { buildAnswerKey, match } from '../src/lib/game/match.js';
import { SHORT_QUIZ_TRACKS } from './fixtures/tracks.js';
import {
	keyboardAdvance,
	keyboardStartFromPreloadGate,
	keyboardSubmitGenerateForm,
	keyboardSubmitNickname,
	keyboardSubmitTextGuess
} from './helpers/keyboard-flow.js';
import { buildManifest } from './helpers/manifest.js';
import { mockClipRoutes, mockSessionApi } from './helpers/mock-api.js';

test('a full quiz is completable keyboard-only, start to summary', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eKeyboardSession01',
		quizId: 'e2eKeyboardQuiz01',
		tracks: SHORT_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	const recorded = await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await keyboardSubmitNickname(page, 'Kbe');
	await keyboardSubmitGenerateForm(page, 'Indila');

	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	await keyboardStartFromPreloadGate(page);

	for (const [index, track] of SHORT_QUIZ_TRACKS.entries()) {
		// Exact answers here — this test is proving keyboard operability
		// (A11Y-6), not fuzzy matching (that's solo-happy-path.e2e.ts).
		const answers = buildAnswerKey({ title: track.title, artists: track.artists });
		expect(match(track.title, answers.title)).toBe(true);
		expect(match(track.artists[0].name, answers.artist)).toBe(true);

		await expect(
			page.getByRole('heading', { name: `Round ${index + 1} of ${SHORT_QUIZ_TRACKS.length}` })
		).toBeVisible();

		await keyboardSubmitTextGuess(page, 'Title', track.title);
		await keyboardSubmitTextGuess(page, 'Artist', track.artists[0].name);

		await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible();
		await keyboardAdvance(page, 'Next');

		await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();
		await keyboardAdvance(page, 'Continue');
	}

	await expect(page.getByRole('heading', { name: 'Quiz complete' })).toBeVisible();

	expect(recorded.starts).toHaveLength(SHORT_QUIZ_TRACKS.length);
	expect(recorded.results).toHaveLength(SHORT_QUIZ_TRACKS.length);
	expect(recorded.finalizeBodies).toHaveLength(1);
});
