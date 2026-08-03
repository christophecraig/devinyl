/**
 * Rate limiting — technical-spec §10, plan task 1.18 (re-specified by §G-10).
 *
 * The spec described in-process token buckets. That assumed one long-lived Node
 * process; Workers isolates share no memory and are created and destroyed
 * freely, so an in-memory bucket would limit nothing — two requests a
 * millisecond apart can land in different isolates. The counter therefore lives
 * in D1, the only strongly-consistent store on the free tier.
 *
 * **Fixed windows, not sliding.** A sliding window needs a row per request; a
 * fixed window needs one row per key per window and exactly one write per
 * request. Against the free tier's 100 k writes/day that difference is the
 * whole design. The cost is the classic fixed-window burst — up to 2× the limit
 * straddling a boundary — which is fine here: these limits exist to stop a
 * script hammering Deezer through us (§5.2's 50 req/5 s obligation) and to cap
 * session churn, not to meter anything precisely.
 *
 * Failure is **open**. If D1 errors, the request proceeds: a limiter outage
 * taking down gameplay would be a worse bug than the burst it prevents.
 */

import { sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { rateLimit } from './db/schema.js';
import { rateLimitedResponse } from './http.js';

export interface LimitSpec {
	/** Bucket name, also the key prefix — e.g. `session_create`. */
	name: string;
	limit: number;
	windowMs: number;
}

/** The three §10 limits, plus generation which shares search's provider budget. */
export const LIMITS = {
	catalogSearch: { name: 'catalog_search', limit: 30, windowMs: 60_000 },
	quizGenerate: { name: 'quiz_generate', limit: 10, windowMs: 60_000 },
	sessionCreate: { name: 'session_create', limit: 10, windowMs: 60_000 },
	finalize: { name: 'finalize', limit: 20, windowMs: 60_000 }
} as const satisfies Record<string, LimitSpec>;

export interface LimitVerdict {
	allowed: boolean;
	/** Seconds until the current window rolls over — the `Retry-After` value. */
	retryAfterSeconds: number;
	remaining: number;
}

/**
 * Count this request against `spec` for `identity` and report the verdict.
 *
 * The upsert is a single statement so the increment is atomic — read-then-write
 * would race between concurrent requests in different isolates, which is the
 * exact failure mode that pushed this out of isolate memory in the first place.
 */
export async function consume(
	db: Db,
	spec: LimitSpec,
	identity: string,
	now: number = Date.now()
): Promise<LimitVerdict> {
	const windowStart = Math.floor(now / spec.windowMs) * spec.windowMs;
	const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + spec.windowMs - now) / 1000));
	const key = `${spec.name}:${identity}`;

	try {
		const [row] = await db
			.insert(rateLimit)
			.values({ key, windowStart, count: 1 })
			.onConflictDoUpdate({
				target: [rateLimit.key, rateLimit.windowStart],
				set: { count: sql`${rateLimit.count} + 1` }
			})
			.returning({ count: rateLimit.count });

		const count = row?.count ?? 1;
		return {
			allowed: count <= spec.limit,
			retryAfterSeconds,
			remaining: Math.max(0, spec.limit - count)
		};
	} catch {
		// Fail open — see the module comment.
		return { allowed: true, retryAfterSeconds, remaining: spec.limit };
	}
}

/**
 * `consume`, returning the §10 429 response when the caller is over the limit
 * and `null` when it may proceed:
 *
 * ```ts
 * const limited = await enforce(db, LIMITS.sessionCreate, identity);
 * if (limited) return limited;
 * ```
 *
 * A returned `Response` rather than a thrown `error()` because §10 requires a
 * `Retry-After` header, and SvelteKit's `error()` can only carry a body.
 */
export async function enforce(
	db: Db,
	spec: LimitSpec,
	identity: string,
	now: number = Date.now()
): Promise<Response | null> {
	const verdict = await consume(db, spec, identity, now);
	return verdict.allowed ? null : rateLimitedResponse(verdict.retryAfterSeconds);
}
