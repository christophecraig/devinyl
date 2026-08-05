import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

export default defineConfig({
	plugins: [
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			// LOC-1: locale is URL-independent. A cookie set by the settings
			// switcher wins; otherwise the browser's Accept-Language decides;
			// otherwise the English baseline.
			strategy: ['cookie', 'preferredLanguage', 'baseLocale']
		}),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// The adapter writes its generated Worker to the `main` path of the
			// config it reads, so it gets a build-only config of its own. The real
			// deploy config (wrangler.jsonc) points `main` at worker/entry.ts, which
			// wraps that artifact to add the `scheduled` export for Cron Triggers.
			adapter: adapter({ config: 'wrangler.build.jsonc' })
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					// Plain node/jsdom unit tests for pure code (S.3). Integration
					// tests run in the real Workers runtime instead — see
					// vitest.integration.config.ts (@cloudflare/vitest-pool-workers)
					// and `pnpm run test:integration`.
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: [
						'src/**/*.svelte.{test,spec}.{js,ts}',
						'src/**/*.integration.{test,spec}.{js,ts}'
					]
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					// Runes tests (`*.svelte.test.ts`). They need the `sveltekit()`
					// plugin to compile `.svelte.ts` modules, which the `unit` project's
					// `exclude` above deliberately keeps out of a plain node run — so
					// they get a project of their own rather than being silently
					// skipped, which is what happened before this existed. A test file
					// that never runs is worse than no test file at all.
					//
					// `environment: 'node'` suffices today: the only runes tests are
					// state machines with no DOM. Testing actual `.svelte` components
					// (1.24+) will need jsdom or vitest browser mode added here.
					name: 'client',
					environment: 'node',
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.integration.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
