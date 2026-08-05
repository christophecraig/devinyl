/**
 * Multiple-choice answer mode — ANS-6/7/8, QUIZ-7, plan task 1.30.
 *
 * `ChoiceAnswer.svelte`'s module doc is explicit about the one behavior this
 * mode exists to prove: a `role="listbox"` per target where arrow keys move a
 * roving `aria-activedescendant` pointer (never committing) and only Enter
 * commits. Whether a *wrong* commit ends the target depends on the quiz's
 * `choiceRetryMode` (QUIZ-7): `oneShot` locks the whole group immediately,
 * right or wrong (ANS-7); `penalty` disables the group for a configured
 * number of seconds after a wrong pick, then reopens it for another try
 * (ANS-8).
 */

import { expect, test } from '@playwright/test';
import { CHOICE_QUIZ_TRACKS } from './fixtures/tracks.js';
import { buildManifest, choicesFromDeck } from './helpers/manifest.js';
import { mockClipRoutes, mockSessionApi } from './helpers/mock-api.js';
import { submitGenerateForm, submitNickname } from './helpers/play-flow.js';

test('a listbox pick locks irreversibly and arrow keys never commit', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eChoiceSession01',
		quizId: 'e2eChoiceQuiz01',
		tracks: CHOICE_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'choice', choiceRetryMode: 'oneShot' },
		choicesFor: choicesFromDeck
	});
	await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await submitNickname(page, 'Chooser');
	await submitGenerateForm(page, 'Indila');
	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	await page.getByRole('button', { name: 'Start quiz' }).click();

	const track = CHOICE_QUIZ_TRACKS[0];
	const listbox = page.getByRole('listbox', { name: 'Title' });
	await expect(listbox).toBeVisible();

	// Scoped to *this* listbox — the Artist listbox on the same round also
	// renders `role="option"` elements, and an unscoped `getByRole('option')`
	// would count both.
	const options = listbox.getByRole('option');
	const correctOption = listbox.getByRole('option', { name: track.title, exact: true });

	// Arrow-key movement is real keyboard interaction — but per ANS-7 it must
	// only move the roving pointer, never commit a pick.
	await listbox.focus();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await expect(options).toHaveCount(4); // sanity: 4 options rendered (ANS-6)
	for (const option of await options.all()) {
		await expect(option).toHaveAttribute('aria-selected', 'false');
	}
	await expect(listbox).toHaveAttribute('aria-disabled', 'false');

	// Move the roving pointer onto the correct option, then commit with Enter.
	// `aria-activedescendant` names which option is currently active — walk
	// forward until it points at the correct one rather than assuming an
	// arrow-count, since `seededShuffle` orders the options per-session.
	for (let i = 0; i < 4; i++) {
		const activeId = await listbox.getAttribute('aria-activedescendant');
		const correctId = await correctOption.getAttribute('id');
		if (activeId === correctId) break;
		await page.keyboard.press('ArrowDown');
	}
	await page.keyboard.press('Enter');

	await expect(listbox).toHaveAttribute('aria-disabled', 'true');
	await expect(correctOption).toHaveAttribute('aria-selected', 'true');

	// ANS-7 irreversibility: further key presses on the now-locked listbox
	// must not change the pick (the component's own `isLocked` guard, not
	// just "the control looks disabled").
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('Enter');
	await expect(correctOption).toHaveAttribute('aria-selected', 'true');
	await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);

	// The Artist listbox is untouched and still fully interactive — locking
	// one target must never lock the other (ANS-1, mirrored from TextAnswer).
	const artistListbox = page.getByRole('listbox', { name: 'Artist' });
	await expect(artistListbox).toHaveAttribute('aria-disabled', 'false');
});

test('under the one-shot retry policy, a wrong pick locks the group too', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eChoiceSession02',
		quizId: 'e2eChoiceQuiz02',
		tracks: CHOICE_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'choice', choiceRetryMode: 'oneShot' },
		choicesFor: choicesFromDeck
	});
	await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await submitNickname(page, 'Chooser');
	await submitGenerateForm(page, 'Indila');
	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	await page.getByRole('button', { name: 'Start quiz' }).click();

	const track = CHOICE_QUIZ_TRACKS[0];
	const listbox = page.getByRole('listbox', { name: 'Title' });
	await expect(listbox).toBeVisible();

	const options = listbox.getByRole('option');
	const wrongOption = options.filter({ hasNotText: track.title }).first();

	// A wrong pick is just as final as a correct one under one-shot: the
	// whole group locks immediately, not just the option that was picked.
	await wrongOption.click();
	await expect(listbox).toHaveAttribute('aria-disabled', 'true');
	await expect(wrongOption).toHaveAttribute('aria-selected', 'true');
});

test('under the penalty retry policy, a wrong pick reopens the group after the penalty', async ({
	page
}) => {
	const manifest = await buildManifest({
		sessionId: 'e2eChoiceSession03',
		quizId: 'e2eChoiceQuiz03',
		tracks: CHOICE_QUIZ_TRACKS,
		settings: {
			guessTarget: 'both',
			answerMode: 'choice',
			choiceRetryMode: 'penalty',
			choiceRetryPenaltySeconds: 1
		},
		choicesFor: choicesFromDeck
	});
	await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await submitNickname(page, 'Chooser');
	await submitGenerateForm(page, 'Indila');
	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	await page.getByRole('button', { name: 'Start quiz' }).click();

	const track = CHOICE_QUIZ_TRACKS[0];
	const listbox = page.getByRole('listbox', { name: 'Title' });
	await expect(listbox).toBeVisible();

	const options = listbox.getByRole('option');
	const correctOption = listbox.getByRole('option', { name: track.title, exact: true });
	const wrongOption = options.filter({ hasNotText: track.title }).first();

	// A wrong pick disables the whole group for the configured penalty
	// window — no free instant retry, unlike text mode.
	await wrongOption.click();
	await expect(listbox).toHaveAttribute('aria-disabled', 'true');

	// After the penalty elapses, the group reopens for another attempt.
	await expect(listbox).toHaveAttribute('aria-disabled', 'false', { timeout: 3000 });

	await correctOption.click();
	await expect(correctOption).toHaveAttribute('aria-selected', 'true');
	await expect(listbox).toHaveAttribute('aria-disabled', 'true');
});
