/**
 * `(share)/i/[userId]` SSR load — FRIEND-1 invite link, plan task 3.7/3.14.
 *
 * The link is the inviter's own id (`friends.ts`'s module doc — no new
 * table needed). Public: opening it just needs the inviter's display name
 * to render the unfurl and the "add as friend" prompt; the actual request
 * is sent by `POST /api/friends/request` once the visitor is signed in.
 */

import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { getInviter } from '$lib/server/friends.js';
import { recordShareEvent } from '$lib/server/metrics.js';
import { requirePlatform } from '$lib/server/http.js';
import { parisDay } from '$lib/server/time.js';

export const load: PageServerLoad = async ({ params, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const inviter = await getInviter(db, params.userId);
	void recordShareEvent(db, parisDay(), 'invite_open').catch(() => {});

	return { inviter };
};
