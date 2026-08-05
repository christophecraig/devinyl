/**
 * Guest → account import — technical-spec §10 `POST /api/me/import-guest`,
 * plan task 2.5 (ACC-4).
 *
 * Three things happen, in this order, plain sequential Drizzle statements
 * rather than a wrapped transaction: the spec's "in one transaction" assumed
 * the Hetzner/better-sqlite3 target (§1 deviation table, ADR-0002); D1 over
 * HTTP has no interactive transaction to wrap this in, and nothing else in
 * this codebase pretends otherwise (finalize.ts does the same multi-step,
 * fails-open thing for the same reason).
 *
 *   1. **Re-attribute** every `game_session` row still carrying the old
 *      `guest_id` to the new account (§10 step 1) — boards and weekly-ladder
 *      credit follow the player, not the identity they happened to be using.
 *   2. **Re-run FAIR-2** across the account's *entire* scored history, not
 *      just the newly re-attributed rows: a guest run and an already-logged-
 *      in run of the same quiz can collide the moment they're merged onto one
 *      account, and the earlier `finalized_at` has to win regardless of which
 *      side it came from.
 *   3. **Backfill weekly_points** — but only for sessions this import just
 *      re-attributed and that survived step 2 still scored. Sessions that
 *      were already the account's own were already credited at their own
 *      finalize; crediting them again here would double-count.
 *
 * The client's local-only `history[]` (ACC-1's `localStorage` blob) is a
 * separate, purely additive step: every entry becomes an `imported_history`
 * row, `quizName`/`rounds`/`isDaily` resolved server-side from the `quiz`
 * table (if it still exists) rather than trusted from the client, which
 * would drift the moment a quiz is renamed or deleted. These never enter any
 * leaderboard (§G-3) — they exist purely for STAT-1 and *best*-streak (§G-7).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { newId } from '../ids.js';
import type { Db } from '../db/index.js';
import {
	gameSession,
	importedHistory,
	quiz,
	quizTrack,
	weeklyPoints as weeklyPointsTable
} from '../db/schema.js';
import { maxPossibleScore, weeklyPoints as weeklyPointsContribution } from '$lib/game/scoring.js';
import { parisIsoWeek } from '../time.js';
import type { ImportGuestBody } from '$lib/game/schemas.js';

type GameSessionRow = typeof gameSession.$inferSelect;

/** Groups scored sessions by the board they compete on — mirrors finalize.ts's FAIR-2 scope. */
function boardKey(row: Pick<GameSessionRow, 'quizId' | 'challengeToken' | 'dailyDay'>): string {
	return `${row.quizId}|${row.challengeToken ?? ''}|${row.dailyDay ?? ''}`;
}

/**
 * FAIR-2, re-run across the whole account: within each (quiz, scope) board,
 * only the earliest-finalized scored session may stay scored. Returns the
 * ids demoted, so the weekly-credit step can skip them.
 */
async function reconcileReplays(db: Db, userId: string): Promise<Set<string>> {
	const scoredRows = await db
		.select()
		.from(gameSession)
		.where(and(eq(gameSession.userId, userId), eq(gameSession.scored, true)));

	const groups = new Map<string, GameSessionRow[]>();
	for (const row of scoredRows) {
		const key = boardKey(row);
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}

	const demoted = new Set<string>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const sorted = [...group].sort((a, b) => (a.finalizedAt ?? 0) - (b.finalizedAt ?? 0));
		for (const loser of sorted.slice(1)) demoted.add(loser.id);
	}

	if (demoted.size > 0) {
		await db
			.update(gameSession)
			.set({ scored: false, scoredBlockReason: 'replay' })
			.where(inArray(gameSession.id, [...demoted]));
	}

	return demoted;
}

/** STAT-4/§11: mirrors finalize.ts's creditWeeklyLadder, for sessions finalize never credited (they finalized as a guest). */
async function backfillWeeklyPoints(db: Db, userId: string, sessionIds: string[]): Promise<void> {
	if (sessionIds.length === 0) return;

	const rows = await db
		.select({
			id: gameSession.id,
			effectiveScoringMode: gameSession.effectiveScoringMode,
			dailyDay: gameSession.dailyDay,
			finalizedAt: gameSession.finalizedAt,
			curveVersion: gameSession.curveVersion,
			totalScore: gameSession.totalScore,
			quizId: gameSession.quizId,
			quizKind: quiz.kind,
			guessTarget: quiz.guessTarget
		})
		.from(gameSession)
		.innerJoin(quiz, eq(quiz.id, gameSession.quizId))
		.where(inArray(gameSession.id, sessionIds));

	for (const row of rows) {
		if (row.quizKind !== 'daily' && row.quizKind !== 'official') continue;
		if (row.totalScore === null || row.finalizedAt === null) continue;

		// maxPossibleScore only reads `.skipped` (§9); a scored session has none
		// by construction (a skipped round blocks scoring entirely, revalidate.ts),
		// so a same-length array of unskipped placeholders is exact, not an estimate.
		const trackRows = await db
			.select({ position: quizTrack.position })
			.from(quizTrack)
			.where(eq(quizTrack.quizId, row.quizId));
		const rounds = trackRows.map(() => ({ skipped: false, clipMs: 0 }));

		const max = maxPossibleScore(rounds, row.guessTarget, row.effectiveScoringMode, row.curveVersion);
		const contribution = weeklyPointsContribution(row.totalScore, max, row.dailyDay !== null);
		if (contribution === 0) continue;

		const week = parisIsoWeek(row.finalizedAt);
		await db
			.insert(weeklyPointsTable)
			.values({ userId, week, points: contribution })
			.onConflictDoUpdate({
				target: [weeklyPointsTable.userId, weeklyPointsTable.week],
				set: { points: sql`${weeklyPointsTable.points} + ${contribution}` }
			});
	}
}

async function importLocalHistory(
	db: Db,
	userId: string,
	history: ImportGuestBody['history']
): Promise<void> {
	if (history.length === 0) return;

	const quizIds = [...new Set(history.map((h) => h.quizId))];
	const quizRows =
		quizIds.length > 0
			? await db
					.select({ id: quiz.id, name: quiz.name, kind: quiz.kind })
					.from(quiz)
					.where(inArray(quiz.id, quizIds))
			: [];
	const byQuizId = new Map(quizRows.map((q) => [q.id, q]));

	const roundCounts = new Map<string, number>();
	for (const q of quizRows) {
		const rows = await db
			.select({ position: quizTrack.position })
			.from(quizTrack)
			.where(eq(quizTrack.quizId, q.id));
		roundCounts.set(q.id, rows.length);
	}

	await db.insert(importedHistory).values(
		history.map((entry) => {
			const quizRow = byQuizId.get(entry.quizId);
			return {
				id: newId(),
				userId,
				quizId: quizRow ? entry.quizId : null,
				quizName: quizRow?.name ?? null,
				totalScore: entry.score,
				rounds: quizRow ? (roundCounts.get(quizRow.id) ?? 0) : 0,
				isDaily: quizRow?.kind === 'daily',
				playedAt: entry.playedAt
			};
		})
	);
}

export interface ImportGuestResult {
	reattributedSessions: number;
	demotedToReplay: number;
	importedHistoryRows: number;
}

export async function importGuest(
	db: Db,
	userId: string,
	body: ImportGuestBody
): Promise<ImportGuestResult> {
	// Step 1 — re-attribution (§10).
	const reattributed = await db
		.update(gameSession)
		.set({ userId, guestId: null })
		.where(eq(gameSession.guestId, body.guestId))
		.returning({ id: gameSession.id, scored: gameSession.scored });

	// Step 2 — FAIR-2, account-wide.
	const demoted = await reconcileReplays(db, userId);

	// Step 3 — weekly credit, only for sessions this import just re-attributed
	// and that are still scored after step 2.
	const creditable = reattributed
		.filter((row) => row.scored && !demoted.has(row.id))
		.map((row) => row.id);
	await backfillWeeklyPoints(db, userId, creditable);

	// Step 4 — local-only history, purely additive stats (never boards).
	await importLocalHistory(db, userId, body.history);

	return {
		reattributedSessions: reattributed.length,
		demotedToReplay: demoted.size,
		importedHistoryRows: body.history.length
	};
}
