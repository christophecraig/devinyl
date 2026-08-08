/**
 * FR/EN switch — plan task 4.12's localization slice of the full-E2E gate.
 *
 * LOC-1 says locale is URL-independent: the `PARAGLIDE_LOCALE` cookie (set
 * by the header's language switcher via `setLocale`) wins over
 * `Accept-Language`, and the switch is a full-document reload so the SSR'd
 * page re-renders localized. This exercises the whole chain in a real
 * browser: default English render → switch to French → French SSR text →
 * cookie survives a fresh navigation → switch back.
 */

import { expect, test } from '@playwright/test';

test('language switcher swaps the SSR locale and persists it across navigations', async ({
	page
}) => {
	await page.goto('/');

	// Default locale (no cookie, Playwright sends English Accept-Language).
	const nav = page.getByRole('navigation');
	await expect(nav.getByRole('link', { name: 'Daily' })).toBeVisible();
	await expect(page.getByText('Devinyl — a French-repertoire music blind test.')).toBeVisible();

	// Switch to French. setLocale reloads the document, so wait for the
	// French nav to appear rather than for any explicit navigation event.
	await page
		.getByRole('group', { name: 'Language' })
		.getByRole('button', { name: 'Français' })
		.click();
	await expect(nav.getByRole('link', { name: 'Quiz du jour' })).toBeVisible();
	await expect(page.getByText('Devinyl — un blind test du répertoire francophone.')).toBeVisible();

	// The cookie — not the URL — carries the locale: a brand-new navigation
	// must come back French without any locale marker in the address.
	await page.goto('/');
	expect(new URL(page.url()).pathname).toBe('/');
	await expect(nav.getByRole('link', { name: 'Quiz du jour' })).toBeVisible();
	const cookies = await page.context().cookies();
	expect(cookies.find((c) => c.name === 'PARAGLIDE_LOCALE')?.value).toBe('fr');

	// And back to English through the same control (now labeled in French).
	await page
		.getByRole('group', { name: 'Langue' })
		.getByRole('button', { name: 'English' })
		.click();
	await expect(nav.getByRole('link', { name: 'Daily' })).toBeVisible();
});
