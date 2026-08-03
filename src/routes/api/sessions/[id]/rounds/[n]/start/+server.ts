/**
 * `POST /api/sessions/:id/rounds/:n/start` — the round-start beacon (§7.1).
 *
 * Fire-and-forget: nothing on the play path waits for it, and it **returns no
 * body**. Round keys are derived client-side from the manifest seed (§7.2), so
 * there is nothing to hand back — the stale §10 table saying otherwise is a
 * known spec inconsistency (plan §G-1). A failed beacon queues client-side and
 * flushes with the next result.
 *
 * 204, not 200: an empty body is the honest status code, and it keeps the
 * response small enough to be genuinely cheap on a phone mid-round.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { loadActiveSession } from '$lib/server/sessions/create.js';
import { recordBeacon } from '$lib/server/sessions/rounds.js';
import { apiError, requirePlatform } from '$lib/server/http.js';
import { requirePlayer } from '$lib/server/identity.js';
import { MAX_ROUNDS } from '$lib/game/types.js';

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const position = Number(params.n);
	if (!Number.isInteger(position) || position < 0 || position >= MAX_ROUNDS) {
		apiError('bad_request', 'Invalid round number.');
	}

	const session = await loadActiveSession(db, params.id, requirePlayer(locals));
	await recordBeacon(db, session, position);

	return new Response(null, { status: 204 });
};
