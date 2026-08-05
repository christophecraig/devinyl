/**
 * Lighthouse CI — plan task 4.3 (§4 table: LCP < 2.5 s on Fast 3G, mid-range
 * phone). `.cjs` because package.json is `"type": "module"` and LHCI's own
 * config loader wants CommonJS.
 *
 * Server: reuses the exact serve step CI already ran for e2e
 * (`pnpm run build` then `pnpm run preview`, same as playwright.config.ts's
 * `webServer` — see ci.yml) rather than inventing a second build/serve path.
 * `startServerCommand` here only runs `preview`; the workflow builds once
 * upstream and both the bundle-size check and Lighthouse reuse that output.
 *
 * Throttling: `throttlingMethod: 'simulate'` with `formFactor: 'mobile'`
 * left at Lighthouse's default mobile network/CPU profile (rttMs 150,
 * throughputKbps ~1638, 4x CPU slowdown) — Lighthouse's long-standing
 * stand-in for "Fast 3G" on a mid-range phone, the same profile the §4
 * table's LCP number is written against. This is a **synthetic
 * approximation**: a GitHub Actions runner's CPU/IO characteristics aren't a
 * mid-range phone even with throttling applied, and simulated throttling
 * models the network, not real radio conditions. Real mobile-network
 * measurement is task 4.14 (launch checklist), not this gate.
 */
module.exports = {
	ci: {
		collect: {
			url: ['http://localhost:4173/'],
			startServerCommand: 'pnpm run preview',
			startServerReadyPattern: 'Ready on',
			startServerReadyTimeout: 30_000,
			numberOfRuns: 3,
			settings: {
				formFactor: 'mobile',
				screenEmulation: {
					mobile: true,
					width: 360,
					height: 640,
					deviceScaleFactor: 2,
					disabled: false
				},
				throttlingMethod: 'simulate'
			}
		},
		assert: {
			assertions: {
				// §4 table: LCP < 2.5s. Everything else Lighthouse would flag
				// (a11y, best-practices, SEO) is out of scope for this budget —
				// axe (A11Y-1) already gates accessibility in the e2e job.
				'largest-contentful-paint': ['error', { maxNumericValue: 2500 }]
			}
		},
		upload: {
			// No LHCI server/Chrome storage account exists (that's infra, not
			// this task) — keep reports as CI artifacts instead.
			target: 'filesystem',
			outputDir: '.lighthouseci'
		}
	}
};
