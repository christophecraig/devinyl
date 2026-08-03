import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config for D1 (SQLite dialect).
 *
 * Migration policy (plan S.4 / technical-spec §15): migrations are versioned
 * SQL files under `drizzle/`, generated here with `pnpm run db:generate` and
 * applied with `wrangler d1 migrations apply` — additive-only between
 * releases. They are applied **in CI only** (the merge-to-main pipeline,
 * S.6), never automatically on Worker boot. `pnpm run db:migrate:local` is
 * the local-dev equivalent of that CI step, run by hand against the local
 * D1 SQLite file for dev/test parity.
 */
export default defineConfig({
	dialect: 'sqlite',
	driver: 'd1-http',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle'
});
