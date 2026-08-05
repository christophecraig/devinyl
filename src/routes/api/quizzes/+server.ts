/**
 * `POST /api/quizzes` — CREATE-1/2, plan task 2.6.
 *
 * The manual builder's write endpoint: name + settings + an ordered list of
 * catalog track ids. Registered players only — a guest has nowhere to own
 * the resulting quiz.
 */

import type { RequestHandler } from './$types';
import { createQuizSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { getProvider } from '$lib/server/catalog/index.js';
import { createManualQuiz } from '$lib/server/quizzes/manage.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { requireUserId } from '$lib/server/identity.js';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	const body = await parseBody(request, createQuizSchema);

	const result = await createManualQuiz(db, getProvider(env), userId, body);
	return json(result, { status: 201 });
};
