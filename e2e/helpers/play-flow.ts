/**
 * Pointer-driven steps through the solo flow, shared by the tests that are
 * not specifically proving keyboard operability (plan task 1.30). The
 * dedicated keyboard-only run lives in `keyboard-flow.ts` instead — it must
 * never call `.click()`, so it doesn't reuse these.
 *
 * Typing into `TextAnswer`'s inputs still dispatches real key events
 * (`pressSequentially`/`press`) rather than `fill()`, because the component
 * has **no submit button** — `Enter` is the only way to lock a guess
 * (`src/lib/components/TextAnswer.svelte`'s `onkeydown`), and `fill()` does
 * not dispatch the keydown that handler listens for.
 */

import type { Page } from '@playwright/test';

export async function submitNickname(page: Page, name: string): Promise<void> {
	// `exact: true`: "Nickname" is a case-insensitive substring of the
	// surrounding section's own accessible name ("Pick a nickname to play"),
	// which `getByLabel`'s default substring matching would also match.
	await page.getByLabel('Nickname', { exact: true }).fill(name);
	await page.getByRole('button', { name: 'Continue' }).click();
}

export async function submitGenerateForm(page: Page, artist: string): Promise<void> {
	await page.getByLabel('Artist', { exact: true }).fill(artist);
	await page.getByRole('button', { name: 'Generate quiz' }).click();
}

export async function startFromPreloadGate(page: Page): Promise<void> {
	await page.getByRole('button', { name: /Start quiz|Download and start/ }).click();
}

/** `Enter` locks the guess (ANS-1/4) — see module doc on why `fill()` alone won't submit. */
export async function submitTextGuess(
	page: Page,
	label: 'Title' | 'Artist',
	text: string
): Promise<void> {
	const input = page.getByLabel(label, { exact: true });
	await input.pressSequentially(text);
	await input.press('Enter');
}

export async function clickNext(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Next' }).click();
}

export async function clickContinue(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Continue' }).click();
}
