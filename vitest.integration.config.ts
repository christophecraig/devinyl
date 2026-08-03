import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

/**
 * Integration tests run inside the real Workers runtime (Miniflare) against
 * local D1, via @cloudflare/vitest-pool-workers (plan S.3) — separate from
 * the plain node/jsdom unit project in vite.config.ts because the two use
 * incompatible Vite plugins/pools. Bindings (the `DB` D1 database, etc.) are
 * read straight from wrangler.jsonc, so this stays in sync with what's
 * actually deployed without duplicating config.
 *
 * Run with `pnpm run test:integration`. Test files: `**\/*.integration.test.ts`.
 *
 * Migrations (task 1.19): `readD1Migrations` walks `drizzle/` and orders by
 * filename, so a new migration file is picked up with zero edits here. Its
 * `node:fs` read has to happen in **this** Node-side config function — test
 * files run inside the Miniflare-sandboxed Workers runtime, which has no
 * host filesystem access — so the parsed migrations are handed across as a
 * plain-data Miniflare binding (`TEST_MIGRATIONS`). `applyD1Migrations`
 * itself only runs inside the runtime (it needs the live `D1Database`
 * binding), so the apply call lives in
 * `src/lib/server/test-utils.integration.ts`'s `ensureMigrations()`, which
 * every integration suite calls in its own `beforeAll`.
 *
 * `resolve.alias` re-declares SvelteKit's `$lib` alias by hand: this config
 * can't use the `sveltekit()` Vite plugin (it and `cloudflareTest`'s pool are
 * mutually incompatible — the comment above), but almost every server module
 * under test (`sessions/create.ts`, `catalog/assembly.ts`, ...) imports
 * `$lib/...` internally, so something has to resolve it. A plain path alias
 * is all `$lib` ever was — no other part of the SvelteKit plugin is needed
 * for that resolution to work here.
 */
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations('./drizzle')
				}
			}
		}))
	],
	test: {
		name: 'integration',
		include: ['src/**/*.integration.{test,spec}.{js,ts}']
	}
});
