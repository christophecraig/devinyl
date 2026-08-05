/**
 * `GET /api/challenges/:token` — CHAL-1/3 lobby read, plan task 3.5. Public.
 */

import type { RequestHandler } from './$types';
import { challengeTokenSchema } from '$lib/game/schemas.js';
import { loadChallengeLobby } from '$lib/server/challenges.js';
import { getDb } from '$lib/server/db/index.js';
import { apiError, json, requirePlatform } from '$lib/server/http.js';

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const token = challengeTokenSchema.safeParse(params.token);
	if (!token.success) apiError('not_found', 'This challenge link is no longer valid.');

	const lobby = await loadChallengeLobby(db, token.data);
	return json({ lobby });
};
