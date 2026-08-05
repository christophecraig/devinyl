/**
 * `GET /api/quizzes/:id/board` — STAT-2, §11, plan task 3.6.
 *
 * Public (SHARE-2: anyone with the quiz link can see its leaderboard) —
 * `optionalPlayer` rather than `requirePlayer`, so a visitor with no
 * account and no guest id yet still gets a board, just with no self row.
 */

import type { RequestHandler } from './$types';
import { boardQuerySchema, idSchema } from '$lib/game/schemas.js';
import { getBoard } from '$lib/server/boards.js';
import { getDb } from '$lib/server/db/index.js';
import { apiError, json, parseQuery, requirePlatform } from '$lib/server/http.js';
import { optionalPlayer } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ params, url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const id = idSchema.safeParse(params.id);
	if (!id.success) apiError('not_found', 'That quiz could not be found.');

	const query = parseQuery(url, boardQuerySchema);
	const player = optionalPlayer(locals);

	const board = await getBoard(
		db,
		{ kind: 'quiz', quizId: id.data },
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
