/**
 * `POST /api/quizzes/:id/duplicate` — CREATE-10, plan task 2.7.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { duplicateQuiz } from '$lib/server/quizzes/manage.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	const result = await duplicateQuiz(db, params.id, userId);
	return json(result, { status: 201 });
};
