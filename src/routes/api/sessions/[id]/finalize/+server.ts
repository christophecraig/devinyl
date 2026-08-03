/**
 * `POST /api/sessions/:id/finalize` — technical-spec §7.3, plan task 1.16.
 *
 * The thin wrapper: rate limit, resolve the player, validate the optional
 * last-chance round flush (MUS-7), and hand off to `finalizeSession`, which
 * owns every actual decision (re-validation, plausibility, identity blocks,
 * board/ladder writes, ephemeral promotion). Nothing scoring-relevant lives
 * in this file on purpose — it is the one place §7.3 is authoritative, and
 * that authority belongs in code that a unit test can reach without HTTP.
 */

import type { RequestHandler } from './$types';
import { finalizeSessionSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { finalizeSession } from '$lib/server/sessions/finalize.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { clientIp, rateLimitIdentity, requirePlayer } from '$lib/server/identity.js';
import { LIMITS, enforce } from '$lib/server/ratelimit.js';

export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const limited = await enforce(db, LIMITS.finalize, rateLimitIdentity(locals, request));
	if (limited) return limited;

	const player = requirePlayer(locals);
	const body = await parseBody(request, finalizeSessionSchema);

	const result = await finalizeSession(db, {
		sessionId: params.id,
		player,
		body,
		// FAIR-7 only ever consults these for a guest finalizing a daily session.
		clientIp: clientIp(request),
		ipHashSecret: env.env.IP_HASH_SECRET
	});

	return json(result);
};
