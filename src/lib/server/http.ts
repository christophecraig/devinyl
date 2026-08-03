/**
 * Shared API response shapes — technical-spec §10.
 *
 * Every error the API returns has the same body — `{ code, message }`, the
 * `App.Error` shape SvelteKit serializes for endpoint requests — so the client
 * has exactly one branch to write. `code` is stable and machine-readable;
 * `message` is a fallback for surfaces without a localized string yet. The
 * client localizes from `code` (LOC-1), never by parsing prose.
 */

import { error, json } from '@sveltejs/kit';

export type ApiErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'gone'
	| 'conflict'
	| 'rate_limited'
	| 'unavailable'
	| 'internal';

const STATUS_FOR: Record<ApiErrorCode, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	gone: 410,
	conflict: 409,
	rate_limited: 429,
	unavailable: 503,
	internal: 500
};

/**
 * Throw an API error. Uses SvelteKit's `error()` so it unwinds the handler the
 * same way a framework error does; `hooks.server.ts` renders the body.
 */
export function apiError(code: ApiErrorCode, message: string, extra?: App.Error['extra']): never {
	error(STATUS_FOR[code], { code, message, ...(extra ? { extra } : {}) });
}

/**
 * The 429 §10 specifies, built by hand rather than thrown through `apiError`:
 * it needs a `Retry-After` **header**, and SvelteKit's `error()` can only carry
 * a body.
 */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
	return json(
		{
			code: 'rate_limited' satisfies ApiErrorCode,
			message: 'Too many requests — please slow down.',
			extra: { retryAfter: retryAfterSeconds }
		},
		{ status: 429, headers: { 'retry-after': String(retryAfterSeconds) } }
	);
}

export { json };

/**
 * Parse and validate a JSON body against a zod schema, failing as a 400 with
 * the first issue's path. Nothing in the API reads `request.json()` directly —
 * everything crossing the wire from a player is hostile until a schema says
 * otherwise (§10, `schemas.ts`).
 */
export async function parseBody<T>(
	request: Request,
	schema: {
		safeParse: (
			value: unknown
		) =>
			| { success: true; data: T }
			| { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
	}
): Promise<T> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		apiError('bad_request', 'Request body must be valid JSON.');
	}

	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.join('.') ?? '';
		apiError(
			'bad_request',
			path ? `${path}: ${issue.message}` : (issue?.message ?? 'Invalid request.')
		);
	}
	return parsed.data;
}

/** Same, for query strings — `searchParams` entries are all strings, so schemas coerce. */
export function parseQuery<T>(
	url: URL,
	schema: {
		safeParse: (
			value: unknown
		) =>
			| { success: true; data: T }
			| { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
	}
): T {
	const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.join('.') ?? '';
		apiError(
			'bad_request',
			path ? `${path}: ${issue.message}` : (issue?.message ?? 'Invalid query.')
		);
	}
	return parsed.data;
}

/**
 * `platform` is optional in SvelteKit's types (it's absent under `vite dev`
 * without the Cloudflare plugin), but every API route here needs D1. One place
 * to fail loudly rather than a non-null assertion in each handler.
 */
export function requirePlatform(platform: App.Platform | undefined): App.Platform {
	if (!platform?.env?.DB) {
		apiError('unavailable', 'The database binding is not available in this environment.');
	}
	return platform;
}
