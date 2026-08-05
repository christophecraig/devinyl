/**
 * `GET/PATCH/DELETE /api/quizzes/:id` — CREATE-3/4, plan tasks 2.6/2.7.
 *
 * GET is the lobby read (§G-6, public — no auth): quiz metadata + round
 * count. PATCH/DELETE require ownership (or operator, for an official/daily
 * quiz) and are the only routes that touch a quiz's content after creation,
 * so the CREATE-3 freeze lives in `quizzes/manage.ts`, not here.
 */

import type { RequestHandler } from './$types';
import { idSchema, patchQuizSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { getProvider } from '$lib/server/catalog/index.js';
import { deleteQuiz, getQuizForLobby, patchQuiz } from '$lib/server/quizzes/manage.js';
import { apiError, json, parseBody, requirePlatform } from '$lib/server/http.js';
import { loadIsOperator, requirePlayer, requireUserId } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const id = idSchema.safeParse(params.id);
	if (!id.success) apiError('not_found', 'That quiz could not be found.');

	const { quiz: quizRow, roundCount } = await getQuizForLobby(db, id.data);
	return json({ quiz: quizRow, roundCount });
};

export const PATCH: RequestHandler = async ({ request, params, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	const isOperator = await loadIsOperator(db, requirePlayer(locals));
	const body = await parseBody(request, patchQuizSchema);

	await patchQuiz(db, getProvider(env), params.id, userId, isOperator, body);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const userId = requireUserId(locals);
	const isOperator = await loadIsOperator(db, requirePlayer(locals));

	await deleteQuiz(db, params.id, userId, isOperator);
	return json({ ok: true });
};
