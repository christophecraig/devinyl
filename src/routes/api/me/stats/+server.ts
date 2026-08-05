/**
 * `GET /api/me/stats` — STAT-1, plan task 3.9.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { getPersonalStats } from '$lib/server/stats.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	const userId = requireUserId(locals);

	const stats = await getPersonalStats(db, userId);
	return json({ stats });
};
