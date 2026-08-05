/**
 * Who is playing — technical-spec §4, §7.1, FAIR-5.
 *
 * V1 has exactly two kinds of player and a session belongs to precisely one:
 *
 *   - a **registered user**, identified by an auth cookie (Phase 2 — until Better
 *     Auth lands, `locals.userId` is always null and every path below takes the
 *     guest branch);
 *   - a **guest**, identified by a client-generated `guestId` in `localStorage`
 *     and sent as `x-guest-id`. That identity is unauthenticated by design:
 *     guests are first-class players (CHAL-3, SOLO-1) and demanding an account
 *     to play would kill the challenge-link loop the product is built on. FAIR-2
 *     and FAIR-7 are the compensations, and both fail open (§7.3 step 6).
 */

import { eq } from 'drizzle-orm';
import { guestIdSchema, nicknameSchema } from '$lib/game/schemas.js';
import type { Db } from './db/index.js';
import { user } from './db/schema.js';
import { apiError } from './http.js';
import { isBlockedName, nameRejectionMessage } from './profanity.js';

export type Player =
	| { kind: 'user'; userId: string; guestId: null }
	| { kind: 'guest'; userId: null; guestId: string };

/** Reads the header without demanding it — `null` for a registered player or a public read. */
export function readGuestId(request: Request): string | null {
	const raw = request.headers.get('x-guest-id');
	if (!raw) return null;
	const parsed = guestIdSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Resolve the player for a route that requires one. A registered session always
 * wins over a stray `x-guest-id` header — otherwise a logged-in player whose
 * old guest blob is still in `localStorage` would silently keep scoring as a
 * guest, and their history would never converge (ACC-4).
 */
export function requirePlayer(locals: App.Locals): Player {
	if (locals.userId) return { kind: 'user', userId: locals.userId, guestId: null };
	if (locals.guestId) return { kind: 'guest', userId: null, guestId: locals.guestId };
	apiError('unauthorized', 'Sign in or send a guest id to play.');
}

/** Resolve the signed-in account for a route that requires one — never a guest. */
export function requireUserId(locals: App.Locals): string {
	if (!locals.userId) apiError('unauthorized', 'Sign in to do this.');
	return locals.userId;
}

/** §15 operator role — gates `/admin` and official/daily curation (CREATE-8/9, FAIR-1). */
export async function loadIsOperator(db: Db, player: Player): Promise<boolean> {
	if (player.kind !== 'user') return false;
	const [row] = await db
		.select({ isOperator: user.isOperator })
		.from(user)
		.where(eq(user.id, player.userId))
		.limit(1);
	return row?.isOperator ?? false;
}

/**
 * Validate a nickname at a **write** point (FAIR-5: at every point a name is
 * set, never on read). Returns the trimmed name.
 *
 * Guests must supply one — it's what appears on the daily board, the most
 * public surface in the product, and there is no account name to fall back on.
 */
export function requireNickname(raw: string | undefined, locale: 'fr' | 'en' = 'fr'): string {
	const parsed = nicknameSchema.safeParse(raw);
	if (!parsed.success) {
		apiError('bad_request', 'Pick a nickname between 2 and 24 characters.');
	}
	if (isBlockedName(parsed.data)) {
		apiError('bad_request', nameRejectionMessage(locale));
	}
	return parsed.data;
}

/**
 * Client IP for the coarse, day-salted FAIR-7 guest-daily claim and for
 * unauthenticated rate limiting. Cloudflare sets `cf-connecting-ip` at the
 * edge and it cannot be spoofed by the client through the proxy; the fallback
 * keeps local dev (`wrangler dev`, no edge) working rather than throwing.
 */
export function clientIp(request: Request): string {
	return (
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-real-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		'0.0.0.0'
	);
}

/** Stable rate-limit identity: the account where there is one, else the guest id, else the IP. */
export function rateLimitIdentity(locals: App.Locals, request: Request): string {
	if (locals.userId) return `user:${locals.userId}`;
	if (locals.guestId) return `guest:${locals.guestId}`;
	return `ip:${clientIp(request)}`;
}
