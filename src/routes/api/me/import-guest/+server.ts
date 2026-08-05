/**
 * `POST /api/me/import-guest` — technical-spec §10, plan task 2.5 (ACC-4).
 *
 * Called once, right after a guest signs up, with the local blob it's about
 * to discard. Requires an account — this is exactly the "guest becomes an
 * account" moment, so there is no guest-identity branch here.
 */

import type { RequestHandler } from './$types';
import { importGuestSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';
import { importGuest } from '$lib/server/me/import-guest.js';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	const body = await parseBody(request, importGuestSchema);

	const result = await importGuest(db, userId, body);
	return json(result);
};
