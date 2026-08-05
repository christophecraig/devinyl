/**
 * `DELETE /api/me` — ACC-6, plan task 2.11.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { deleteAccount } from '$lib/server/me/delete-account.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const DELETE: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	await deleteAccount(db, userId, env.env.BETTER_AUTH_SECRET);
	return json({ ok: true });
};
