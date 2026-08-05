/**
 * `GET /api/friends` — FRIEND-1, plan task 3.7: accepted friends + pending requests.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { listFriends, listPendingRequests } from '$lib/server/friends.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	const userId = requireUserId(locals);

	const [friends, pending] = await Promise.all([
		listFriends(db, userId),
		listPendingRequests(db, userId)
	]);
	return json({ friends, pending });
};
