/**
 * `POST /api/quizzes/:id/publish` — CREATE-8/LOC-3, plan task 2.9.
 */

import type { RequestHandler } from './$types';
import { publishOfficialSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { publishOfficial } from '$lib/server/admin/index.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { requireOperator } from '$lib/server/identity.js';

export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	await requireOperator(db, locals);
	const body = await parseBody(request, publishOfficialSchema);

	await publishOfficial(db, params.id, body);
	return json({ ok: true });
};
