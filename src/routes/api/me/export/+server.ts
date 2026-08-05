/**
 * `GET /api/me/export` — LEGAL-4, §16, plan task 4.4.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { exportUserData } from '$lib/server/me/export.js';
import { requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	const userId = requireUserId(locals);

	const data = await exportUserData(db, userId);

	// A real download, not just a JSON API shape — §16 wants this "reachable
	// from the profile UI without contacting support", and a browser hitting
	// this URL directly (no UI page yet, task 4.4's scoped-out follow-up)
	// should still come away with a file rather than an in-tab JSON blob.
	return new Response(JSON.stringify(data, null, 2), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'content-disposition': 'attachment; filename="devinyl-export.json"'
		}
	});
};
