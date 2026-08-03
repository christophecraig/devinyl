/**
 * Keyboard-only navigation primitives for the A11Y-6 full-quiz run (plan
 * task 1.30). Every step here drives real keys — `page.keyboard.press`/
 * `page.keyboard.type` dispatch actual `KeyboardEvent`s the app's own
 * `onkeydown` handlers and native focus order react to — and never calls
 * `.click()`, `.focus()`, or `.selectOption()`.
 *
 * `tabUntilFocused` is the one deliberate compromise: real Tab order depends
 * on exactly how many other focusable elements a phase renders (a banner, a
 * different button layout, ...), and hard-coding "press Tab N times" would
 * make the test change every time an unrelated element is added anywhere in
 * the DOM before the target. Bounding the loop and asserting it actually
 * reached the target keeps this from silently passing on a stuck tab order —
 * a run that can never Tab to a control is exactly the bug this test exists
 * to catch.
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function tabUntilFocused(page: Page, target: Locator, maxPresses = 40): Promise<void> {
	for (let i = 0; i < maxPresses; i++) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	// One more explicit check so the failure message points at the real
	// locator rather than a generic "loop exhausted" throw.
	await expect(
		target,
		`could not reach this control within ${maxPresses} Tab presses`
	).toBeFocused();
}

export async function keyboardSubmitNickname(page: Page, name: string): Promise<void> {
	// `exact: true`: "Nickname" is a case-insensitive substring of the
	// surrounding section's own accessible name ("Pick a nickname to play").
	const input = page.getByLabel('Nickname', { exact: true });
	await tabUntilFocused(page, input);
	await page.keyboard.type(name);
	const button = page.getByRole('button', { name: 'Continue' });
	await tabUntilFocused(page, button);
	await page.keyboard.press('Enter');
}

export async function keyboardSubmitGenerateForm(page: Page, artist: string): Promise<void> {
	const input = page.getByLabel('Artist', { exact: true });
	await tabUntilFocused(page, input);
	await page.keyboard.type(artist);
	const button = page.getByRole('button', { name: 'Generate quiz' });
	await tabUntilFocused(page, button);
	await page.keyboard.press('Enter');
}

export async function keyboardStartFromPreloadGate(page: Page): Promise<void> {
	const button = page.getByRole('button', { name: /Start quiz|Download and start/ });
	await tabUntilFocused(page, button);
	await page.keyboard.press('Enter');
}

/** `Enter` locks the guess (ANS-1/4) — `TextAnswer.svelte` has no submit button. */
export async function keyboardSubmitTextGuess(
	page: Page,
	label: 'Title' | 'Artist',
	text: string
): Promise<void> {
	const input = page.getByLabel(label, { exact: true });
	// Not tabbed to on the *first* target of a round: the phase-change effect
	// (`play/[quizId]/+page.svelte`) moves focus into the round's `<section>`,
	// and `TextAnswer`'s own Title input is that section's first focusable
	// descendant — so it is already focused. Tabbing here is still correct
	// when it isn't (e.g. the Artist field once Title is locked and focus was
	// deliberately moved forward), and a no-op loop iteration is harmless
	// when it already is.
	await tabUntilFocused(page, input);
	await page.keyboard.type(text);
	await page.keyboard.press('Enter');
}

export async function keyboardAdvance(page: Page, buttonName: 'Next' | 'Continue'): Promise<void> {
	const button = page.getByRole('button', { name: buttonName });
	await tabUntilFocused(page, button);
	await page.keyboard.press('Enter');
}
