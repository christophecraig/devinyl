/**
 * Axe gate across the solo-play states — A11Y-1, plan task 1.30.
 *
 * `e2e/home.e2e.ts` already proves the CI gate is wired up for `/`. This
 * file extends the same zero-serious/critical-violations bar (§17) to every
 * other state the plan calls out: the preload gate, an in-clip round, a
 * round's reveal, and the end summary. Each is scanned in place — no
 * shortcuts through `page.evaluate`-injected DOM — so axe sees exactly what
 * a player's browser renders.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SHORT_QUIZ_TRACKS } from './fixtures/tracks.js';
import { buildManifest } from './helpers/manifest.js';
import { mockClipRoutes, mockSessionApi } from './helpers/mock-api.js';
import {
	clickNext,
	submitGenerateForm,
	submitNickname,
	submitTextGuess
} from './helpers/play-flow.js';

async function assertNoSeriousOrCriticalViolations(
	page: import('@playwright/test').Page
): Promise<void> {
	const results = await new AxeBuilder({ page }).analyze();
	const seriousOrCritical = results.violations.filter(
		(v) => v.impact === 'serious' || v.impact === 'critical'
	);
	expect(seriousOrCritical, JSON.stringify(seriousOrCritical, null, 2)).toEqual([]);
}

test('solo-play states have no serious/critical accessibility violations', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eAxeSession01',
		quizId: 'e2eAxeQuiz01',
		tracks: SHORT_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await submitNickname(page, 'Auditor');
	await submitGenerateForm(page, 'Indila');

	await test.step('preload gate', async () => {
		await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
		await assertNoSeriousOrCriticalViolations(page);
	});

	await page.getByRole('button', { name: 'Start quiz' }).click();

	await test.step('in-clip round', async () => {
		await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
		await assertNoSeriousOrCriticalViolations(page);
	});

	await test.step('round reveal', async () => {
		const track = SHORT_QUIZ_TRACKS[0];
		await submitTextGuess(page, 'Title', track.title);
		await submitTextGuess(page, 'Artist', track.artists[0].name);
		await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible();
		await assertNoSeriousOrCriticalViolations(page);
	});

	// Play out the remaining rounds to reach the summary.
	await clickNext(page);
	for (const track of SHORT_QUIZ_TRACKS.slice(1)) {
		await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();
		await page.getByRole('button', { name: 'Continue' }).click();
		await submitTextGuess(page, 'Title', track.title);
		await submitTextGuess(page, 'Artist', track.artists[0].name);
		await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible();
		await clickNext(page);
	}
	await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();
	await page.getByRole('button', { name: 'Continue' }).click();

	await test.step('summary', async () => {
		await expect(page.getByRole('heading', { name: 'Quiz complete' })).toBeVisible();
		await assertNoSeriousOrCriticalViolations(page);
	});
});
