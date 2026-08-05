import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import pkg from '../../../../package.json' with { type: 'json' };

/**
 * Ops (plan 4.8): this is the target an external uptime monitor
 * (healthchecks.io's HTTP check, [USER] — see docs/implementation-plan.md §L)
 * polls. A 200 that doesn't actually touch D1 would miss the failure mode
 * that matters most (the binding is misconfigured or the database is down),
 * so this pings it with `SELECT 1` — the cheapest query that proves the
 * connection round-trips — before answering.
 *
 * Bounded by `DB_PING_TIMEOUT_MS` so a hung D1 call can't make this endpoint
 * itself the slow/timing-out thing an uptime monitor flags; a monitor is
 * polling this frequently (every 1-5 min typically), so the check has to
 * stay cheap regardless of outcome.
 */
const DB_PING_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

export const GET: RequestHandler = async ({ platform }) => {
	// No `DB` binding at all (e.g. `vite dev` without the Cloudflare plugin) is
	// its own degraded case — same "don't throw, report the fact" convention
	// hooks.server.ts uses for the missing-binding case.
	if (!platform?.env?.DB) {
		return json({ ok: false, version: pkg.version, db: 'unavailable' }, { status: 503 });
	}

	try {
		await withTimeout(platform.env.DB.prepare('SELECT 1').first(), DB_PING_TIMEOUT_MS);
		return json({ ok: true, version: pkg.version, db: 'ok' });
	} catch (err) {
		console.error('[healthz] D1 ping failed', err);
		return json({ ok: false, version: pkg.version, db: 'error' }, { status: 503 });
	}
};
