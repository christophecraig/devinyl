/**
 * Axe gate over the legal routes — extends the A11Y-1 bar (§17) to the two
 * pages task 4.5 added. Static prose, so unlike axe-routes.e2e.ts there is
 * no play-state machinery to walk — but they carry the app's only long-form
 * document structure (TOC nav, anchor links, mixed-language notes), which is
 * exactly the kind of markup that quietly grows heading/landmark violations.
 * Scanned in both locales since the prose is two distinct DOM renders, not
 * one translated string set.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

async function assertNoSeriousOrCriticalViolations(
	page: import('@playwright/test').Page
): Promise<void> {
	const results = await new AxeBuilder({ page }).analyze();
	const seriousOrCritical = results.violations.filter(
		(v) => v.impact === 'serious' || v.impact === 'critical'
	);
	expect(seriousOrCritical, JSON.stringify(seriousOrCritical, null, 2)).toEqual([]);
}

const routes = [
	{ path: '/legal/privacy', en: 'Privacy Policy', fr: 'Politique de confidentialité' },
	{ path: '/legal/terms', en: 'Terms of Service', fr: "Conditions générales d'utilisation" }
];

for (const route of routes) {
	test(`${route.path} passes axe in both locales`, async ({ page }) => {
		await page.goto(route.path);
		await expect(page.getByRole('heading', { level: 1, name: route.en })).toBeVisible();
		await assertNoSeriousOrCriticalViolations(page);

		// French render is a different document (content.ts's fr object), so it
		// gets its own scan rather than assuming the English pass covers it.
		await page
			.getByRole('group', { name: 'Language' })
			.getByRole('button', { name: 'Français' })
			.click();
		await expect(page.getByRole('heading', { level: 1, name: route.fr })).toBeVisible();
		await assertNoSeriousOrCriticalViolations(page);
	});
}
