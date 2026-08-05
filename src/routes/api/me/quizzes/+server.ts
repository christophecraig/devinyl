/**
 * `GET /api/me/quizzes` — §G-6, plan task 2.7. "My quizzes" list for the builder/dashboard.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { listMyQuizzes } from '$lib/server/quizzes/manage.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	const quizzes = await listMyQuizzes(db, userId);
	return json({ quizzes });
};
