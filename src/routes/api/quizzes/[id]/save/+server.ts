/**
 * `POST /api/quizzes/:id/save` — CREATE-6, plan task 2.8.
 *
 * Claims an unowned generated quiz: sets `ownerId`, clears the ephemeral
 * TTL. The track list is already frozen the moment the quiz exists
 * (CREATE-7) — saving only changes who owns it and whether it expires.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { saveGeneratedQuiz } from '$lib/server/quizzes/manage.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	await saveGeneratedQuiz(db, params.id, userId);
	return json({ ok: true });
};
