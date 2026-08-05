/**
 * `GET /api/catalog/search` — plan task 2.6, technical-spec §10.
 *
 * Auth-gated (unlike quiz generation): free-text catalog search is the
 * manual builder's own search box, not something a guest needs before
 * playing. Server-cached at the provider layer (`catalog/deezer.ts`'s 24 h
 * search cache, task 1.9) — nothing extra to cache here.
 */

import type { RequestHandler } from './$types';
import { catalogSearchSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { getProvider } from '$lib/server/catalog/index.js';
import { json, parseQuery, requirePlatform } from '$lib/server/http.js';
import { rateLimitIdentity, requireUserId } from '$lib/server/identity.js';
import { LIMITS, enforce } from '$lib/server/ratelimit.js';

export const GET: RequestHandler = async ({ request, url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	requireUserId(locals);

	const limited = await enforce(db, LIMITS.catalogSearch, rateLimitIdentity(locals, request));
	if (limited) return limited;

	const { q } = parseQuery(url, catalogSearchSchema);
	const results = await getProvider(env).searchTracks(q);
	return json({ results });
};
