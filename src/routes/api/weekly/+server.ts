/**
 * `GET /api/weekly` — STAT-4, §11, plan task 3.8. Public board, optional identity for `isSelf`.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { getWeeklyBoard } from '$lib/server/weekly.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { optionalPlayer } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	const player = optionalPlayer(locals);

	const board = await getWeeklyBoard(db, {
		userId: player?.kind === 'user' ? player.userId : null
	});
	return json(board);
};
