import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
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
			}
		]
	}
});
