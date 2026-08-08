/**
 * Playwright `globalSetup` — prepares the local D1 the preview server reads
 * (plan task 3.13's last open item).
 *
 * `playwright.config.ts`'s `webServer` runs `wrangler dev
 * .svelte-kit/cloudflare/_worker.js`, i.e. a real Workers runtime whose `DB`
 * binding is a real local D1 persisted under `.wrangler/state/v3/d1` —
 * **the same directory `wrangler d1 execute --local` writes to** (both
 * default to `.wrangler/state`, and wrangler prints the path it used on every
 * `d1 execute`; verified against this repo before wiring this up, so no
 * `--persist-to` override is needed on either side). Seeding it here is what
 * lets `e2e/challenge-lobby.e2e.ts` cover a page that is rendered from D1
 * during SSR, which `page.route` can never reach.
 *
 * Playwright starts `webServer` before global setup runs, so these writes land
 * while the preview server is already up. That is fine: D1's local store is a
 * WAL-mode SQLite file read per query, so the next request sees them. Nothing
 * here restarts or waits on the server.
 *
 * Idempotent by construction — `d1 migrations apply` skips what is already
 * recorded in `d1_migrations`, and `buildSeedSql()` deletes its own previous
 * rows before re-inserting them.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeedSql } from './fixtures/challenge-seed.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The workspace binary directly, rather than `pnpm exec` — one process fewer,
// and it does not depend on a package manager being on PATH.
const WRANGLER = path.join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
/** `wrangler.jsonc`'s `d1_databases[0].database_name`. */
const DATABASE = 'devinyl';

function wrangler(args: string[]): void {
	execFileSync(WRANGLER, args, {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'inherit'],
		// `wrangler dev` can be slow to release its file lock on a cold start;
		// migrations + a ~30-statement seed are still well inside this.
		timeout: 120_000
	});
}

export default function globalSetup(): void {
	wrangler(['d1', 'migrations', 'apply', DATABASE, '--local']);

	const sqlPath = path.join(mkdtempSync(path.join(tmpdir(), 'devinyl-e2e-seed-')), 'seed.sql');
	writeFileSync(sqlPath, buildSeedSql());
	wrangler(['d1', 'execute', DATABASE, '--local', `--file=${sqlPath}`]);
}
