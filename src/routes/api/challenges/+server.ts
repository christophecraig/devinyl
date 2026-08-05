/**
 * `POST /api/challenges` — CHAL-1, plan task 3.5.
 */

import type { RequestHandler } from './$types';
import { createChallengeSchema } from '$lib/game/schemas.js';
import { createChallenge } from '$lib/server/challenges.js';
import { getDb } from '$lib/server/db/index.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { requirePlayer } from '$lib/server/identity.js';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const player = requirePlayer(locals);
	const body = await parseBody(request, createChallengeSchema);

	const result = await createChallenge(db, { sessionId: body.sessionId, player });
	return json(result, { status: 201 });
};
