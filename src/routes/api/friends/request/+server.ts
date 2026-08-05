/**
 * `POST /api/friends/request` — FRIEND-1, plan task 3.7.
 *
 * Doubles as both "send a request" and "accept a pending one" —
 * `requestFriend` figures out which from the existing row, if any
 * (`friends.ts`'s "mutual accept" doc comment). One endpoint, no separate
 * accept action for the client to call.
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { idSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { requestFriend } from '$lib/server/friends.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

const bodySchema = z.object({ userId: idSchema });

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	const userId = requireUserId(locals);
	const body = await parseBody(request, bodySchema);

	const result = await requestFriend(db, userId, body.userId);
	return json(result, { status: 201 });
};
