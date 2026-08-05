/**
 * `GET /api/friends/search?q=` — FRIEND-1 username search, plan task 3.7.
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getDb } from '$lib/server/db/index.js';
import { searchUsers } from '$lib/server/friends.js';
import { json, parseQuery, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

const querySchema = z.object({ q: z.string().trim().min(2).max(40) });

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	const userId = requireUserId(locals);
	const { q } = parseQuery(url, querySchema);

	const results = await searchUsers(db, q, userId);
	return json({ results });
};
