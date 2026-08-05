/**
 * `(share)/c/[token]` SSR load — CHAL-1/3, SHARE-4, plan task 3.5/3.14.
 *
 * Server-rendered (not a client fetch, unlike `/play/[quizId]`) because the
 * unfurl needs the challenger's nickname and score to beat in the response
 * HTML itself — a link preview bot never runs client JS. The 404/410 cases
 * fall through to SvelteKit's own error page rather than a friendly
 * in-app one; CHAL-1's promise is "the link works", and a dead link is
 * a genuinely exceptional case here, unlike a soft-deleted quiz (CREATE-4).
 */

import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { loadChallengeLobby } from '$lib/server/challenges.js';
import { recordShareEvent } from '$lib/server/metrics.js';
import { requirePlatform } from '$lib/server/http.js';
import { parisDay } from '$lib/server/time.js';

export const load: PageServerLoad = async ({ params, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const lobby = await loadChallengeLobby(db, params.token);
	// MET-1: a "challenge opened" counter, fire-and-forget — a metrics write
	// failing must never fail the page (§15's own counters are best-effort).
	void recordShareEvent(db, parisDay(), 'challenge_open').catch(() => {});

	return { lobby };
};
