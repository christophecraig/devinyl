/**
 * `POST /api/metrics/event` — MET-1, plan §G-2 / task 3.11.
 *
 * The client fires this on a share action or a challenge/invite lobby view.
 * No identity is read or stored — just today's Paris day and a `kind`, so
 * the body carries nothing that could re-identify a player (MET-3).
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getDb } from '$lib/server/db/index.js';
import { recordShareEvent } from '$lib/server/metrics.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { parisDay } from '$lib/server/time.js';

const bodySchema = z.object({
	kind: z.enum(['daily_share', 'challenge_open', 'quiz_open', 'invite_open'])
});

export const POST: RequestHandler = async ({ request, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const body = await parseBody(request, bodySchema);
	await recordShareEvent(db, parisDay(), body.kind);
	return json({ ok: true }, { status: 202 });
};
