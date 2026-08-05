/**
 * Leaderboards — technical-spec §11, STAT-2, CHAL-2, DAILY-2, plan task 3.6.
 *
 * One query shape serves all four boards (a quiz's generic board, a
 * challenge's board, a day's daily board, and — via `weekly.ts` — the
 * weekly ladder): `scored AND completed`, ordered
 * `total_score DESC, finalized_at ASC` (FAIR-3's tie-break — whoever posted
 * the score first wins a tie), segmented by `effective_scoring_mode`
 * (A11Y-5) so the untimed board never mixes with the timed one.
 *
 * Pagination is keyset (cursor), not offset: an offset would shift under a
 * board that keeps gaining rows while someone pages through it, which is
 * exactly what a live leaderboard does. The cursor encodes the last seen
 * `(totalScore, finalizedAt, id)` tuple.
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Board, BoardEntry, ScoringMode } from '$lib/game/types.js';
import type { Db } from './db/index.js';
import { friendship, gameSession } from './db/schema.js';
import type { Player } from './identity.js';

export type BoardScope =
	| { kind: 'quiz'; quizId: string }
	| { kind: 'challenge'; token: string }
	| { kind: 'daily'; day: string };

export interface BoardQueryOptions {
	mode: ScoringMode;
	/** SHARE-2: a board is publicly viewable, so an anonymous visitor is valid — `null`. */
	player: Player | null;
	friendsOnly: boolean;
	cursor?: string | null;
	limit?: number;
}

function scopeWhere(scope: BoardScope) {
	if (scope.kind === 'quiz') {
		return and(eq(gameSession.quizId, scope.quizId), isNull(gameSession.challengeToken));
	}
	if (scope.kind === 'challenge') {
		return eq(gameSession.challengeToken, scope.token);
	}
	return eq(gameSession.dailyDay, scope.day);
}

interface Cursor {
	totalScore: number;
	finalizedAt: number;
	id: string;
}

// `btoa`/`atob`, not `Buffer` — this runs in the Workers runtime, which has
// no Node `Buffer` global. The cursor's JSON is ASCII-only (numbers and a
// nanoid), so no unicode escaping is needed beyond making the alphabet
// URL-safe for a value that ends up in a query string.
function encodeCursor(c: Cursor): string {
	return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string): Cursor | null {
	try {
		const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
		const parsed = JSON.parse(atob(padded));
		if (
			typeof parsed.totalScore === 'number' &&
			typeof parsed.finalizedAt === 'number' &&
			typeof parsed.id === 'string'
		) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

/** §11: registered players only — a guest has no `friendship` rows. */
async function loadFriendUserIds(db: Db, userId: string): Promise<Set<string>> {
	const rows = await db
		.select({ a: friendship.aUserId, b: friendship.bUserId })
		.from(friendship)
		.where(
			and(
				eq(friendship.status, 'accepted'),
				or(eq(friendship.aUserId, userId), eq(friendship.bUserId, userId))
			)
		);
	return new Set(rows.map((r) => (r.a === userId ? r.b : r.a)));
}

/** A11Y-5: shown only where the untimed board actually has entries — costs one indexed EXISTS check. */
async function hasUntimedEntries(db: Db, scope: BoardScope): Promise<boolean> {
	const [row] = await db
		.select({ id: gameSession.id })
		.from(gameSession)
		.where(
			and(
				scopeWhere(scope),
				eq(gameSession.effectiveScoringMode, 'fixed'),
				eq(gameSession.scored, true),
				eq(gameSession.status, 'completed')
			)
		)
		.limit(1);
	return Boolean(row);
}

interface RankedRow {
	id: string;
	userId: string | null;
	guestId: string | null;
	nickname: string;
	totalScore: number;
	finalizedAt: number;
}

/** The self player's own best-ranked row in this scope, even if it's outside the top page. */
async function loadSelfRow(
	db: Db,
	scope: BoardScope,
	mode: ScoringMode,
	player: Player | null
): Promise<RankedRow | null> {
	if (!player) return null;
	const identity =
		player.kind === 'user'
			? eq(gameSession.userId, player.userId)
			: eq(gameSession.guestId, player.guestId);

	const rows = await db
		.select({
			id: gameSession.id,
			userId: gameSession.userId,
			guestId: gameSession.guestId,
			nickname: gameSession.nickname,
			totalScore: gameSession.totalScore,
			finalizedAt: gameSession.finalizedAt
		})
		.from(gameSession)
		.where(
			and(
				scopeWhere(scope),
				eq(gameSession.effectiveScoringMode, mode),
				eq(gameSession.scored, true),
				eq(gameSession.status, 'completed'),
				identity
			)
		)
		.orderBy(desc(gameSession.totalScore), asc(gameSession.finalizedAt))
		.limit(1);

	const row = rows[0];
	if (!row || row.totalScore === null || row.finalizedAt === null) return null;
	return { ...row, totalScore: row.totalScore, finalizedAt: row.finalizedAt };
}

/** 1-indexed rank: how many rows strictly outrank this one, per the same tie-break, plus one. */
async function rankOf(
	db: Db,
	scope: BoardScope,
	mode: ScoringMode,
	row: RankedRow
): Promise<number> {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)` })
		.from(gameSession)
		.where(
			and(
				scopeWhere(scope),
				eq(gameSession.effectiveScoringMode, mode),
				eq(gameSession.scored, true),
				eq(gameSession.status, 'completed'),
				or(
					gt(gameSession.totalScore, row.totalScore),
					and(
						eq(gameSession.totalScore, row.totalScore),
						lt(gameSession.finalizedAt, row.finalizedAt)
					)
				)
			)
		);
	return count + 1;
}

function toBoardEntry(
	row: RankedRow,
	rank: number,
	player: Player | null,
	friendIds: Set<string>
): BoardEntry {
	const isSelf = player
		? player.kind === 'user'
			? row.userId === player.userId
			: row.guestId === player.guestId
		: false;
	return {
		rank,
		name: row.nickname,
		totalScore: row.totalScore,
		finalizedAt: row.finalizedAt,
		isSelf,
		isFriend: row.userId !== null && friendIds.has(row.userId)
	};
}

export async function getBoard(db: Db, scope: BoardScope, opts: BoardQueryOptions): Promise<Board> {
	const limit = opts.limit ?? 50;
	const friendIds =
		opts.player?.kind === 'user'
			? await loadFriendUserIds(db, opts.player.userId)
			: new Set<string>();

	const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

	const conditions = [
		scopeWhere(scope),
		eq(gameSession.effectiveScoringMode, opts.mode),
		eq(gameSession.scored, true),
		eq(gameSession.status, 'completed')
	];
	if (opts.friendsOnly && opts.player?.kind === 'user') {
		const ids = [...friendIds, opts.player.userId];
		conditions.push(inArray(gameSession.userId, ids));
	}
	if (cursor) {
		conditions.push(
			or(
				lt(gameSession.totalScore, cursor.totalScore),
				and(
					eq(gameSession.totalScore, cursor.totalScore),
					gt(gameSession.finalizedAt, cursor.finalizedAt)
				),
				and(
					eq(gameSession.totalScore, cursor.totalScore),
					eq(gameSession.finalizedAt, cursor.finalizedAt),
					gt(gameSession.id, cursor.id)
				)
			)!
		);
	}

	const rows = await db
		.select({
			id: gameSession.id,
			userId: gameSession.userId,
			guestId: gameSession.guestId,
			nickname: gameSession.nickname,
			totalScore: gameSession.totalScore,
			finalizedAt: gameSession.finalizedAt
		})
		.from(gameSession)
		.where(and(...conditions))
		.orderBy(desc(gameSession.totalScore), asc(gameSession.finalizedAt), asc(gameSession.id))
		.limit(limit + 1);

	const page = rows
		.slice(0, limit)
		.filter(
			(r): r is RankedRow & { totalScore: number; finalizedAt: number } =>
				r.totalScore !== null && r.finalizedAt !== null
		);
	const nextCursor =
		rows.length > limit && page.length > 0
			? encodeCursor({
					totalScore: page[page.length - 1].totalScore,
					finalizedAt: page[page.length - 1].finalizedAt,
					id: page[page.length - 1].id
				})
			: null;

	// Ranks are absolute (position on the *whole* board), not page-relative —
	// only correct for the first page without a per-row rank query. Cheap
	// enough here (an index-covered ordered scan) since page sizes are ≤ 50.
	const baseRank = cursor ? await rankOfCursor(db, scope, opts.mode, cursor) : 0;
	const entries = page.map((row, i) => toBoardEntry(row, baseRank + i + 1, opts.player, friendIds));

	const selfRow = await loadSelfRow(db, scope, opts.mode, opts.player);
	const selfEntry = selfRow
		? toBoardEntry(selfRow, await rankOf(db, scope, opts.mode, selfRow), opts.player, friendIds)
		: null;

	return {
		entries,
		selfEntry,
		mode: opts.mode,
		hasUntimedEntries: await hasUntimedEntries(db, scope),
		nextCursor
	};
}

/** How many rows outrank the cursor position — the page's starting rank minus one. */
async function rankOfCursor(
	db: Db,
	scope: BoardScope,
	mode: ScoringMode,
	cursor: Cursor
): Promise<number> {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)` })
		.from(gameSession)
		.where(
			and(
				scopeWhere(scope),
				eq(gameSession.effectiveScoringMode, mode),
				eq(gameSession.scored, true),
				eq(gameSession.status, 'completed'),
				or(
					gt(gameSession.totalScore, cursor.totalScore),
					and(
						eq(gameSession.totalScore, cursor.totalScore),
						lt(gameSession.finalizedAt, cursor.finalizedAt)
					),
					and(
						eq(gameSession.totalScore, cursor.totalScore),
						eq(gameSession.finalizedAt, cursor.finalizedAt),
						lt(gameSession.id, cursor.id)
					)
				)
			)
		);
	return count;
}
