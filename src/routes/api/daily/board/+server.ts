/**
 * `GET /api/daily/board` — DAILY-2 global + friends daily leaderboard, plan task 3.6. Public.
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { boardQuerySchema } from '$lib/game/schemas.js';
import { getBoard } from '$lib/server/boards.js';
import { getDb } from '$lib/server/db/index.js';
import { apiError, json, parseQuery, requirePlatform } from '$lib/server/http.js';
import { optionalPlayer } from '$lib/server/identity.js';
import { parisDay } from '$lib/server/time.js';

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const rawDay = url.searchParams.get('day');
	if (rawDay !== null && !daySchema.safeParse(rawDay).success) {
		apiError('bad_request', 'day must be YYYY-MM-DD.');
	}

	const query = parseQuery(url, boardQuerySchema);
	const player = optionalPlayer(locals);

	const board = await getBoard(
		db,
		{ kind: 'daily', day: rawDay ?? parisDay() },
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
