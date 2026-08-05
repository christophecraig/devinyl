/**
 * `GET/POST /api/admin/daily` — CREATE-9, plan task 2.9.
 *
 * GET returns the next 14 days (matching 4.14's launch bar), one entry per
 * day, `quizId: null` marking a gap. POST schedules one day.
 */

import type { RequestHandler } from './$types';
import { scheduleDailySchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { getDailyCalendar, scheduleDaily } from '$lib/server/admin/index.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { requireOperator } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	await requireOperator(db, locals);
	const calendar = await getDailyCalendar(db);
	return json({ calendar });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	await requireOperator(db, locals);
	const body = await parseBody(request, scheduleDailySchema);

	await scheduleDaily(db, body.day, body.quizId);
	return json({ ok: true }, { status: 201 });
};
