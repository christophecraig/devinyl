/**
 * `GET /api/quizzes/official` — SHARE-3, plan task 2.9. Public browse of the official catalog.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { listOfficialQuizzes } from '$lib/server/admin/index.js';
import { json, requirePlatform } from '$lib/server/http.js';

export const GET: RequestHandler = async ({ platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const quizzes = await listOfficialQuizzes(db);
	return json({ quizzes });
};
