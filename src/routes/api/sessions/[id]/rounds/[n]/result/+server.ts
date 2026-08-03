/**
 * `POST /api/sessions/:id/rounds/:n/result` — technical-spec §7.2, plan task 1.15.
 *
 * This endpoint **stores, it does not score**. Everything the client sends is
 * raw evidence: the guess log, the times it claims it locked, the clip duration
 * it measured. Correctness and points are recomputed from scratch at finalize
 * (§7.3) using the same pure functions the client ran, so a client that lies
 * here only lies to itself — the claim lands in `claimed_*` and gets compared,
 * never trusted.
 *
 * Queued beacons ride along (§4): a round played through a connection drop has
 * no server-observed start, and flushing the client's reconstructed offsets
 * here is what keeps it eligible for the *reconstructed* plausibility tier
 * instead of being thrown away. MUS-7 promises play survives a drop.
 */

import type { RequestHandler } from './$types';
import { roundResultSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { loadActiveSession } from '$lib/server/sessions/create.js';
import { mergeQueuedBeacons, recordRoundResult } from '$lib/server/sessions/rounds.js';
import { apiError, parseBody, requirePlatform } from '$lib/server/http.js';
import { requirePlayer } from '$lib/server/identity.js';

export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const body = await parseBody(request, roundResultSchema);

	// The position lives in both the URL and the body; a mismatch is a client
	// bug that would otherwise silently write the wrong round.
	if (Number(params.n) !== body.position) {
		apiError('bad_request', 'Round number does not match the submitted result.');
	}

	const session = await loadActiveSession(db, params.id, requirePlayer(locals));
	const receivedAt = Date.now();

	// Beacons first: `recordRoundResult` is an upsert and may be retried, but a
	// flushed beacon must land even if this round's row already existed.
	await mergeQueuedBeacons(db, session, body.queuedBeacons ?? [], receivedAt);
	await recordRoundResult(db, session, body, receivedAt);

	return new Response(null, { status: 204 });
};
