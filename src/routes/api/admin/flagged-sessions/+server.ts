/**
 * `GET /api/admin/flagged-sessions` — §15 `/admin` view, plan task 2.9.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { listFlaggedSessions } from '$lib/server/admin/index.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireOperator } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	await requireOperator(db, locals);
	const sessions = await listFlaggedSessions(db);
	return json({ sessions });
};
