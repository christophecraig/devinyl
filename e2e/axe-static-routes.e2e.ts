/**
 * Axe sweep over every route reachable without an account — plan task 4.12's
 * "axe on every route" clause (A11Y-1, §17).
 *
 * The other axe specs cover the states this one structurally cannot:
 * `axe-routes.e2e.ts` walks the solo-play machine (preload gate, in-clip,
 * reveal, summary), `legal-axe.e2e.ts` scans the two long-form documents in
 * both locales, and `home.e2e.ts` proves the gate itself is wired. What was
 * left unscanned until this file were the plain pages — auth forms, stats,
 * the daily's empty state — plus the SSR share lobby, which only became
 * scannable once `global-setup.ts` started seeding real D1 rows (3.13).
 *
 * Routes needing an operator (`/admin`) or a specific signed-in user
 * (`/complete-profile`, `(share)/i/[userId]`) are deliberately absent: a
 * guest hitting them renders an unauthorized/redirect state, so scanning
 * them here would assert the accessibility of an error page rather than of
 * the route. They stay covered by the play-state and legal sweeps' shared
 * shell (masthead, nav, language switcher, footer), which is where the
 * landmark/contrast violations those pages could realistically grow live.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SEED_CHALLENGE_TOKEN } from './fixtures/challenge-seed.js';

const ROUTES = [
	{ path: '/', label: 'landing' },
	{ path: '/daily', label: 'daily (no quiz scheduled)' },
	{ path: '/stats', label: 'stats (guest)' },
	{ path: '/login', label: 'login' },
	{ path: '/signup', label: 'signup' },
	{ path: `/c/${SEED_CHALLENGE_TOKEN}`, label: 'challenge lobby (SSR, seeded D1)' }
];

for (const route of ROUTES) {
	test(`${route.label} has no serious/critical accessibility violations`, async ({ page }) => {
		await page.goto(route.path);
		// Every one of these routes renders at least one <h1>; waiting on it
		// rather than on `networkidle` means axe never scans a half-hydrated
		// document. `.first()` because a route can legitimately show two — the
		// guest nickname prompt (§4) overlays the challenge lobby with its own.
		await expect(page.locator('h1').first()).toBeVisible();

		const results = await new AxeBuilder({ page }).analyze();
		const seriousOrCritical = results.violations.filter(
			(v) => v.impact === 'serious' || v.impact === 'critical'
		);
		expect(seriousOrCritical, JSON.stringify(seriousOrCritical, null, 2)).toEqual([]);
	});
}
