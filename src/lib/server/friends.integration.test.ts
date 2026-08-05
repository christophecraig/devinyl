/**
 * Friends — FRIEND-1, plan task 3.7.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	getInviter,
	listFriends,
	listPendingRequests,
	requestFriend,
	searchUsers
} from './friends.js';
import { createUser, ensureMigrations, resetDb, testDb } from './test-utils.integration.js';

const db = testDb();

beforeAll(async () => {
	await ensureMigrations();
});
beforeEach(async () => {
	await resetDb(db);
});

describe('requestFriend (FRIEND-1)', () => {
	it('creates a pending request, then mutual-accepts when the other side requests back', async () => {
		const a = await createUser(db, { displayName: 'Alice', displayNameNormalized: 'alice' });
		const b = await createUser(db, { displayName: 'Bob', displayNameNormalized: 'bob' });

		const first = await requestFriend(db, a.id, b.id);
		expect(first.status).toBe('pending');

		const stillPending = await requestFriend(db, a.id, b.id);
		expect(stillPending.status).toBe('pending');

		const accepted = await requestFriend(db, b.id, a.id);
		expect(accepted.status).toBe('accepted');

		const friendsOfA = await listFriends(db, a.id);
		expect(friendsOfA.map((f) => f.userId)).toEqual([b.id]);
		const friendsOfB = await listFriends(db, b.id);
		expect(friendsOfB.map((f) => f.userId)).toEqual([a.id]);
	});

	it('refuses a self-request', async () => {
		const a = await createUser(db);
		await expect(requestFriend(db, a.id, a.id)).rejects.toThrow();
	});

	it('404s a non-existent target', async () => {
		const a = await createUser(db);
		await expect(requestFriend(db, a.id, 'nonexistent-user-id')).rejects.toThrow();
	});

	it('listPendingRequests separates incoming from outgoing', async () => {
		const a = await createUser(db, { displayName: 'Alice', displayNameNormalized: 'alice' });
		const b = await createUser(db, { displayName: 'Bob', displayNameNormalized: 'bob' });
		await requestFriend(db, a.id, b.id);

		const aView = await listPendingRequests(db, a.id);
		expect(aView.outgoing.map((r) => r.userId)).toEqual([b.id]);
		expect(aView.incoming).toEqual([]);

		const bView = await listPendingRequests(db, b.id);
		expect(bView.incoming.map((r) => r.userId)).toEqual([a.id]);
		expect(bView.outgoing).toEqual([]);
	});
});

describe('searchUsers', () => {
	it('matches on normalized display name, case/diacritic-insensitively, excluding the requester', async () => {
		await createUser(db, { displayName: 'Théo Martin', displayNameNormalized: 'theo martin' });
		const requester = await createUser(db, {
			displayName: 'Requester',
			displayNameNormalized: 'requester'
		});

		const results = await searchUsers(db, 'theo', requester.id);
		expect(results.map((r) => r.displayName)).toEqual(['Théo Martin']);
	});

	it('never returns the requester themselves', async () => {
		const requester = await createUser(db, {
			displayName: 'Self Match',
			displayNameNormalized: 'self match'
		});
		const results = await searchUsers(db, 'self', requester.id);
		expect(results).toEqual([]);
	});
});

describe('getInviter (FRIEND-1 invite link)', () => {
	it('resolves the inviter public profile', async () => {
		const user = await createUser(db, { displayName: 'Inviter', displayNameNormalized: 'inviter' });
		const inviter = await getInviter(db, user.id);
		expect(inviter).toEqual({ userId: user.id, displayName: 'Inviter' });
	});

	it('404s for an unknown id', async () => {
		await expect(getInviter(db, 'nonexistent')).rejects.toThrow();
	});
});
