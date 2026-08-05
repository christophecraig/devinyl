/**
 * `GET /api/daily` — DAILY-1/2/5, plan task 3.1. Public.
 *
 * `?day=YYYY-MM-DD` loads a past daily as practice (DAILY-5); omitted, it's
 * today's. `alreadyPlayed` only resolves when the caller carries an
 * identity — an anonymous visitor always sees `false` and finds out for
 * real at `POST /api/sessions` (FAIR-2/7 are enforced there, not here).
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getDaily } from '$lib/server/daily.js';
import { getDb } from '$lib/server/db/index.js';
import { apiError, json, requirePlatform } from '$lib/server/http.js';
import { optionalPlayer } from '$lib/server/identity.js';

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const rawDay = url.searchParams.get('day') ?? undefined;
	if (rawDay !== undefined && !daySchema.safeParse(rawDay).success) {
		apiError('bad_request', 'day must be YYYY-MM-DD.');
	}

	const daily = await getDaily(db, optionalPlayer(locals), rawDay);
	return json({ daily });
};
