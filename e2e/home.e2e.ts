import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Smoke test (S.3): the home page renders and has zero serious/critical axe
// violations. Per-route axe coverage lands with the routes themselves
// (1.30, 4.12); this proves the CI gate (A11Y-1) is wired up.
test('home page has no serious/critical accessibility violations', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toBeVisible();

	const results = await new AxeBuilder({ page }).analyze();
	const seriousOrCritical = results.violations.filter(
		(violation) => violation.impact === 'serious' || violation.impact === 'critical'
	);

	expect(seriousOrCritical, JSON.stringify(seriousOrCritical, null, 2)).toEqual([]);
});
