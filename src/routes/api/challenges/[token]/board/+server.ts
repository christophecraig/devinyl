/**
 * `GET /api/challenges/:token/board` — CHAL-2 mini-leaderboard, plan task 3.6. Public.
 */

import type { RequestHandler } from './$types';
import { boardQuerySchema, challengeTokenSchema } from '$lib/game/schemas.js';
import { getBoard } from '$lib/server/boards.js';
import { getDb } from '$lib/server/db/index.js';
import { apiError, json, parseQuery, requirePlatform } from '$lib/server/http.js';
import { optionalPlayer } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ params, url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const token = challengeTokenSchema.safeParse(params.token);
	if (!token.success) apiError('not_found', 'This challenge link is no longer valid.');

	const query = parseQuery(url, boardQuerySchema);
	const player = optionalPlayer(locals);

	const board = await getBoard(
		db,
		{ kind: 'challenge', token: token.data },
		{
			mode: query.mode ?? 'speed',
			player,
			friendsOnly: query.friends,
			cursor: query.cursor,
			limit: query.limit
		}
	);
	return json({ board });
};
