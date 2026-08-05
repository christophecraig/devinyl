/**
 * `DELETE /api/me` — technical-spec §6 "Deletion semantics", §16, ACC-6,
 * plan task 2.11.
 *
 * The spec's "hard-delete the user row" and the schema's `deletedEmailHash`/
 * `deletedEmailHashExpiresAt` columns — which only make sense on a row that
 * still exists — read as contradictory until you notice §16's actual
 * requirement: the email survives 30 days as a salted hash specifically to
 * block instant re-registration abuse. That needs a row to hold the hash.
 * So deletion here is **immediate tombstoning, not immediate removal**:
 *
 *   1. Every session and credential is deleted now — the account is
 *      unusable from this instant, full stop.
 *   2. Friendships, weekly-ladder rows, and local-only imported history are
 *      hard-deleted now — pure PII nobody else depends on.
 *   3. This player's own `game_session` rows are anonymized in place
 *      (`user_id → NULL`, nickname → "Deleted player") rather than removed —
 *      the score stays on whichever board it was on (FAIR-3, board
 *      integrity for the *other* players who share that board), the
 *      identity doesn't.
 *   4. Owned quizzes are orphaned, never hard-deleted (`owner_id → NULL`,
 *      `deleted_at` set) — CREATE-4's friendly dead-link page, not a
 *      broken FK for anyone still holding the link.
 *   5. The `user` row itself is scrubbed of every identifying field and
 *      left behind as a tombstone: email replaced with a non-deliverable
 *      placeholder (the real one keyed-hashed into `deletedEmailHash`),
 *      display name replaced, avatar/birth year/flags cleared.
 *
 * A later purge (`jobs/index.ts`, mirroring the FAIR-7 guest-claim pattern)
 * removes the tombstone row outright once `deletedEmailHashExpiresAt`
 * passes — the actual "then purged" from the schema comment.
 */

import { eq, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
	account,
	friendship,
	gameSession,
	importedHistory,
	quiz,
	session,
	user,
	weeklyPoints,
	weeklyRankSnapshot
} from '../db/schema.js';

const encoder = new TextEncoder();

/** 30 days — long enough to deter someone re-registering to dodge a ban, short enough to actually purge (§16). */
export const DELETED_EMAIL_HASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Keyed the same way FAIR-7's `hashGuestIp` keys an IP (`finalize.ts`): an
 * unkeyed digest of an email is not a pseudonym — email addresses are
 * guessable, and a per-user salt doesn't help when the attacker can just
 * hash their own guess and compare. Only a secret they don't hold does.
 */
async function hashEmail(secret: string, email: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`devinyl/acc6/${email.toLowerCase()}`)
	);
	return toHex(new Uint8Array(mac));
}

export async function deleteAccount(
	db: Db,
	userId: string,
	secret: string,
	now: number = Date.now()
): Promise<void> {
	const [row] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!row) return; // Idempotent — a retried request after success is a no-op, not an error.

	await db.delete(session).where(eq(session.userId, userId));
	await db.delete(account).where(eq(account.userId, userId));

	await db
		.delete(friendship)
		.where(or(eq(friendship.aUserId, userId), eq(friendship.bUserId, userId)));
	await db.delete(weeklyPoints).where(eq(weeklyPoints.userId, userId));
	await db.delete(weeklyRankSnapshot).where(eq(weeklyRankSnapshot.userId, userId));
	await db.delete(importedHistory).where(eq(importedHistory.userId, userId));

	await db
		.update(gameSession)
		.set({ userId: null, nickname: 'Deleted player' })
		.where(eq(gameSession.userId, userId));

	await db.update(quiz).set({ ownerId: null, deletedAt: now }).where(eq(quiz.ownerId, userId));

	const deletedEmailHash = await hashEmail(secret, row.email);
	await db
		.update(user)
		.set({
			email: `deleted-${userId}@deleted.invalid`,
			name: 'Deleted player',
			displayName: 'Deleted player',
			displayNameNormalized: `deleted player ${userId}`,
			image: null,
			avatarUrl: null,
			birthYear: null,
			extendedInput: false,
			isOperator: false,
			deletedEmailHash,
			deletedEmailHashExpiresAt: now + DELETED_EMAIL_HASH_TTL_MS
		})
		.where(eq(user.id, userId));
}
