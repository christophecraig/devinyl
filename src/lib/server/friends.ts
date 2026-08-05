/**
 * Friends — FRIEND-1/2, plan task 3.7.
 *
 * `friendship` (§6) stores one row per pair under the invariant
 * `a_user_id < b_user_id`, so every helper here normalizes the pair before
 * touching the table — otherwise the same friendship could exist as two
 * different rows depending on who acted first.
 *
 * The invite link (FRIEND-1) needs no new table: the link *is* the inviting
 * user's own id (task 3.14's `(share)/i/[userId]` route) — ids are already
 * exposed on every board and quiz-lobby response, so this adds no new
 * information, just a shortcut to "friend request this person".
 */

import { and, eq, like, ne, or } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { friendship, user } from './db/schema.js';
import { apiError } from './http.js';

function pair(a: string, b: string): [string, string] {
	return a < b ? [a, b] : [b, a];
}

export interface FriendSummary {
	userId: string;
	displayName: string;
}

/** FRIEND-1: username search, excluding the requester themselves. */
export async function searchUsers(
	db: Db,
	query: string,
	excludeUserId: string
): Promise<FriendSummary[]> {
	const rows = await db
		.select({ id: user.id, displayName: user.displayName })
		.from(user)
		.where(
			and(like(user.displayNameNormalized, `%${query.toLowerCase()}%`), ne(user.id, excludeUserId))
		)
		.limit(20);
	return rows.map((r) => ({ userId: r.id, displayName: r.displayName }));
}

/**
 * Send a request, or accept one that's already pending the other way —
 * "mutual accept" (FRIEND-1) means opening B's invite link after B already
 * requested A completes the friendship immediately rather than creating a
 * second, contradictory pending row.
 */
export async function requestFriend(
	db: Db,
	fromUserId: string,
	toUserId: string
): Promise<{ status: 'pending' | 'accepted' }> {
	if (fromUserId === toUserId) apiError('bad_request', "You can't friend yourself.");

	const [targetExists] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.id, toUserId))
		.limit(1);
	if (!targetExists) apiError('not_found', 'That player could not be found.');

	const [a, b] = pair(fromUserId, toUserId);
	const [existing] = await db
		.select()
		.from(friendship)
		.where(and(eq(friendship.aUserId, a), eq(friendship.bUserId, b)))
		.limit(1);

	if (!existing) {
		await db
			.insert(friendship)
			.values({ aUserId: a, bUserId: b, status: 'pending', requestedBy: fromUserId });
		return { status: 'pending' };
	}

	if (existing.status === 'accepted') return { status: 'accepted' };

	if (existing.requestedBy === fromUserId) {
		// Already requested by this same side — no-op, still pending.
		return { status: 'pending' };
	}

	// The other side already requested; this call is the accept.
	await db
		.update(friendship)
		.set({ status: 'accepted' })
		.where(and(eq(friendship.aUserId, a), eq(friendship.bUserId, b)));
	return { status: 'accepted' };
}

export async function listFriends(db: Db, userId: string): Promise<FriendSummary[]> {
	const rows = await db
		.select({
			aUserId: friendship.aUserId,
			bUserId: friendship.bUserId,
			aName: user.displayName
		})
		.from(friendship)
		.innerJoin(user, eq(user.id, friendship.aUserId))
		.where(
			and(
				eq(friendship.status, 'accepted'),
				or(eq(friendship.aUserId, userId), eq(friendship.bUserId, userId))
			)
		);

	// The join above only resolved `a`'s name; resolve `b` separately since
	// either side of the pair might be "the other person" depending on `userId`.
	const otherIds = rows.map((r) => (r.aUserId === userId ? r.bUserId : r.aUserId));
	if (otherIds.length === 0) return [];

	const others = await db
		.select({ id: user.id, displayName: user.displayName })
		.from(user)
		.where(or(...otherIds.map((id) => eq(user.id, id))));
	return others.map((o) => ({ userId: o.id, displayName: o.displayName }));
}

/** FRIEND-1 invite link (`(share)/i/[userId]`, task 3.14): the inviter's public-facing name. */
export async function getInviter(db: Db, userId: string): Promise<FriendSummary> {
	const [row] = await db
		.select({ id: user.id, displayName: user.displayName })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!row) apiError('not_found', 'That invite link is no longer valid.');
	return { userId: row.id, displayName: row.displayName };
}

export interface PendingRequests {
	incoming: FriendSummary[];
	outgoing: FriendSummary[];
}

export async function listPendingRequests(db: Db, userId: string): Promise<PendingRequests> {
	const rows = await db
		.select({
			aUserId: friendship.aUserId,
			bUserId: friendship.bUserId,
			requestedBy: friendship.requestedBy
		})
		.from(friendship)
		.where(
			and(
				eq(friendship.status, 'pending'),
				or(eq(friendship.aUserId, userId), eq(friendship.bUserId, userId))
			)
		);

	const otherIdsFor = (fromMe: boolean) =>
		rows
			.filter((r) => (r.requestedBy === userId) === fromMe)
			.map((r) => (r.aUserId === userId ? r.bUserId : r.aUserId));

	const incomingIds = otherIdsFor(false);
	const outgoingIds = otherIdsFor(true);
	const allIds = [...new Set([...incomingIds, ...outgoingIds])];
	if (allIds.length === 0) return { incoming: [], outgoing: [] };

	const users = await db
		.select({ id: user.id, displayName: user.displayName })
		.from(user)
		.where(or(...allIds.map((id) => eq(user.id, id))));
	const byId = new Map(users.map((u) => [u.id, u.displayName]));

	return {
		incoming: incomingIds.map((id) => ({ userId: id, displayName: byId.get(id) ?? '' })),
		outgoing: outgoingIds.map((id) => ({ userId: id, displayName: byId.get(id) ?? '' }))
	};
}
