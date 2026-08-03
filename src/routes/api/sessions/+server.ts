/**
 * `POST /api/sessions` — technical-spec §7.1, plan task 1.14.
 *
 * Guests are first-class here (CHAL-3): a challenge link opens, a nickname is
 * typed, and play starts. That is the whole loop the product is built on, so
 * this endpoint must never require an account.
 *
 * The nickname is profanity-checked at this exact point (FAIR-5) because for a
 * guest it is the *only* name-set point there is, and it's what shows on the
 * daily board.
 */

import type { RequestHandler } from './$types';
import { createSessionSchema } from '$lib/game/schemas.js';
import { getDb } from '$lib/server/db/index.js';
import { getProvider } from '$lib/server/catalog/index.js';
import { createSession, type SessionTarget } from '$lib/server/sessions/create.js';
import { json, parseBody, requirePlatform } from '$lib/server/http.js';
import { rateLimitIdentity, requireNickname, requirePlayer } from '$lib/server/identity.js';
import { LIMITS, enforce } from '$lib/server/ratelimit.js';
import { eq } from 'drizzle-orm';
import { user } from '$lib/server/db/schema.js';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const limited = await enforce(db, LIMITS.sessionCreate, rateLimitIdentity(locals, request));
	if (limited) return limited;

	const body = await parseBody(request, createSessionSchema);
	const player = requirePlayer(locals);

	// A registered player's board name is their account display name — it was
	// already filtered when it was set, and letting a request override it per
	// session would make the filter trivially bypassable.
	let nickname: string;
	if (player.kind === 'user') {
		const [row] = await db
			.select({ displayName: user.displayName })
			.from(user)
			.where(eq(user.id, player.userId))
			.limit(1);
		nickname = row?.displayName ?? requireNickname(body.nickname);
	} else {
		nickname = requireNickname(body.nickname);
	}

	// The schema already guarantees exactly one of the three is set.
	const target: SessionTarget = body.quizId
		? { kind: 'quiz', quizId: body.quizId }
		: body.challengeToken
			? { kind: 'challenge', token: body.challengeToken }
			: { kind: 'daily' };

	const manifest = await createSession(db, getProvider(env), { target, player, nickname });
	return json(manifest, { status: 201 });
};
