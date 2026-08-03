/**
 * `POST /api/quizzes/generate` — CREATE-5, plan task 1.13.
 *
 * Open to guests: generating a quiz is the entry point to SOLO-1 and the
 * challenge loop, and gating it behind an account would put a signup wall in
 * front of the first thing anyone does.
 *
 * Rate-limited because each call can reach Deezer, and §5.2's 50 req/5 s budget
 * is shared by every player at once.
 */

import type { RequestHandler } from './$types';
import { generationFiltersSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { getProvider } from '$lib/server/catalog/index.js';
import { themeByKey } from '$lib/server/catalog/themes.js';
import { generateQuiz } from '$lib/server/quizzes/generate.js';
import { apiError, json, parseBody, requirePlatform } from '$lib/server/http.js';
import { rateLimitIdentity } from '$lib/server/identity.js';
import { LIMITS, enforce } from '$lib/server/ratelimit.js';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const limited = await enforce(db, LIMITS.quizGenerate, rateLimitIdentity(locals, request));
	if (limited) return limited;

	const filters = await parseBody(request, generationFiltersSchema);

	// The schema can only check the *shape* of a theme key; membership of the
	// curated list is what actually keeps unvetted free-text out of a provider
	// search (plan §G-8).
	if (filters.theme && !themeByKey(filters.theme)) {
		apiError('bad_request', 'Unknown theme.');
	}

	const result = await generateQuiz(db, getProvider(env), filters);
	return json(result, { status: 201 });
};
