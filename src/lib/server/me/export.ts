/**
 * `GET /api/me/export` — technical-spec §16 "Data export (GDPR access,
 * LEGAL-4): JSON dump endpoint under `/api/me/export`, reachable from the
 * profile UI without contacting support", plan task 4.4.
 *
 * The spec gives no shape for the dump beyond "JSON dump" — this module's
 * job is to decide one. The organizing principle is the same question
 * `delete-account.ts` answers for deletion: which tables hold a row that
 * traces back to `userId`? The two functions are deliberately siblings —
 * anything deletion touches, export should at least consider surfacing,
 * because "what does Devinyl know about me" and "what does Devinyl erase
 * about me" are the same underlying inventory read two different ways.
 *
 * What's deliberately **excluded**, and why (this is the part a GDPR access
 * request actually turns on — over-including is as much a bug as
 * under-including):
 *
 *   - `session` / `account` (Better Auth) rows: these hold live session
 *     tokens, OAuth access/refresh tokens, and a password hash. Handing a
 *     user's own long-lived secrets back to them inside a downloadable JSON
 *     file is a bigger security exposure than the export is worth — a
 *     leaked export becomes an account-takeover artifact, not just a data
 *     dump. GDPR Art. 15 access is about the *personal data*, not the
 *     *credentials protecting it*; we still surface which auth providers
 *     are linked (a plain fact the user already knows) without the tokens.
 *   - `extendedInput`: §16's own addendum treats this accessibility flag as
 *     sensitive and says "never exposed on any public surface" — but this
 *     export is not public, it's the user's own data about themself, so it
 *     stays in. (Listed here to make the omission-vs-inclusion reasoning
 *     explicit for whoever reads this next to whoever reads delete-account.ts.)
 *   - `rate_limit`, `daily_guest_claim`, `metrics_daily`, `share_event`:
 *     none of these are keyed by `userId` (they're IP-hash/day/anonymous-
 *     counter tables per §16 and §G-2) — there is nothing here to attribute
 *     to a specific account in the first place.
 */

import { eq, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
	account,
	friendship,
	gameSession,
	importedHistory,
	quiz,
	roundResult,
	user,
	weeklyPoints,
	weeklyRankSnapshot
} from '../db/schema.js';

export interface UserDataExport {
	/** Wall-clock time the dump was generated — lets a re-request be told apart from an older one. */
	exportedAt: number;
	profile: {
		email: string;
		displayName: string;
		avatarUrl: string | null;
		locale: 'fr' | 'en';
		/** LEGAL-1 — year only, same granularity the app itself ever stores. */
		birthYear: number | null;
		/** A11Y-5 preference (§16) — sensitive on public surfaces, not in a user's own export of themself. */
		extendedInput: boolean;
		createdAt: number;
	};
	/**
	 * Which sign-in methods are linked (`'credential'`, `'google'`, …) — a
	 * fact the user already knows, listed with no tokens/password attached.
	 * See the module doc for why the full `account`/`session` rows are excluded.
	 */
	linkedAuthProviders: string[];
	/**
	 * Quizzes this account owns, **including soft-deleted ones** (CREATE-4):
	 * a user who deleted a quiz might still want a record that they made it.
	 * Never includes another owner's quizzes — filtered by `ownerId` only.
	 */
	ownedQuizzes: {
		id: string;
		kind: string;
		name: string;
		description: string | null;
		guessTarget: string;
		answerMode: string;
		scoringMode: string;
		createdAt: number;
		updatedAt: number;
		deletedAt: number | null;
	}[];
	/**
	 * This is the bulk of "what does Devinyl know about me": every session
	 * this account played, each with its own round-by-round results
	 * (including the raw guess log — the actual text/timing the player
	 * submitted, not just the pass/fail outcome). Sessions still attributed
	 * to a *guest* id are never reachable here — this only ever selects on
	 * `gameSession.userId`, and a guest run only gains a `userId` via
	 * `import-guest.ts`'s re-attribution, at which point it's genuinely
	 * this account's history.
	 */
	gameSessions: {
		id: string;
		quizId: string;
		nickname: string;
		status: string;
		scored: boolean;
		scoredBlockReason: string | null;
		effectiveScoringMode: string;
		dailyDay: string | null;
		challengeToken: string | null;
		totalScore: number | null;
		startedAt: number;
		finalizedAt: number | null;
		rounds: {
			position: number;
			titleOk: boolean | null;
			artistOk: boolean | null;
			skipped: boolean;
			clipMs: number;
			titleMs: number | null;
			artistMs: number | null;
			points: number;
			guessLog: { target: 'title' | 'artist'; raw: string; atMs: number }[];
		}[];
	}[];
	weeklyPoints: { week: string; points: number }[];
	weeklyRankSnapshots: { week: string; rank: number; points: number }[];
	/**
	 * Friend relationships, reduced to the other player's id/display name and
	 * the relationship's own status/direction — never the raw `friendship`
	 * table dump, which would otherwise expose the internal `a_user_id <
	 * b_user_id` ordering invariant as if it meant something to the reader.
	 */
	friendships: {
		friendUserId: string;
		friendDisplayName: string;
		status: 'pending' | 'accepted';
		/** True if this account sent the request, so the export reads as "who did what" rather than a bare list. */
		requestedByMe: boolean;
	}[];
	/** ACC-4 local-only import rows (§G-3) — never on a leaderboard, but still this account's stated history. */
	importedHistory: {
		quizName: string | null;
		totalScore: number;
		rounds: number;
		isDaily: boolean;
		playedAt: number;
	}[];
}

export async function exportUserData(
	db: Db,
	userId: string,
	now: number = Date.now()
): Promise<UserDataExport> {
	const [profileRow] = await db
		.select({
			email: user.email,
			displayName: user.displayName,
			avatarUrl: user.avatarUrl,
			locale: user.locale,
			birthYear: user.birthYear,
			extendedInput: user.extendedInput,
			createdAt: user.createdAt
		})
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!profileRow) {
		// Callers gate on `requireUserId`, so this means the session outlived
		// the account (e.g. mid-deletion) rather than a real caller error.
		throw new Error(`exportUserData: no user row for ${userId}`);
	}

	const authRows = await db
		.select({ providerId: account.providerId })
		.from(account)
		.where(eq(account.userId, userId));

	const quizRows = await db
		.select({
			id: quiz.id,
			kind: quiz.kind,
			name: quiz.name,
			description: quiz.description,
			guessTarget: quiz.guessTarget,
			answerMode: quiz.answerMode,
			scoringMode: quiz.scoringMode,
			createdAt: quiz.createdAt,
			updatedAt: quiz.updatedAt,
			deletedAt: quiz.deletedAt
		})
		.from(quiz)
		.where(eq(quiz.ownerId, userId));

	const sessionRows = await db
		.select({
			id: gameSession.id,
			quizId: gameSession.quizId,
			nickname: gameSession.nickname,
			status: gameSession.status,
			scored: gameSession.scored,
			scoredBlockReason: gameSession.scoredBlockReason,
			effectiveScoringMode: gameSession.effectiveScoringMode,
			dailyDay: gameSession.dailyDay,
			challengeToken: gameSession.challengeToken,
			totalScore: gameSession.totalScore,
			startedAt: gameSession.startedAt,
			finalizedAt: gameSession.finalizedAt
		})
		.from(gameSession)
		.where(eq(gameSession.userId, userId));

	// One query for every round of every one of this account's sessions,
	// then grouped in memory — cheaper than a round-trip per session, and
	// D1 has no interactive transaction to batch these under anyway (§10
	// deviation, import-guest.ts's header comment explains the same call).
	const roundsBySession = new Map<string, UserDataExport['gameSessions'][number]['rounds']>();
	if (sessionRows.length > 0) {
		const sessionIds = new Set(sessionRows.map((s) => s.id));
		const roundRows = await db
			.select({
				sessionId: roundResult.sessionId,
				position: roundResult.position,
				titleOk: roundResult.titleOk,
				artistOk: roundResult.artistOk,
				skipped: roundResult.skipped,
				clipMs: roundResult.clipMs,
				titleMs: roundResult.titleMs,
				artistMs: roundResult.artistMs,
				points: roundResult.points,
				guessLog: roundResult.guessLog
			})
			.from(roundResult)
			.where(
				// `roundResult` has no `userId` column — it belongs to a session
				// (cascades on `session_id`), so cross-user leakage would mean a
				// row with a `sessionId` outside this account's own set. Filtered
				// in memory against `sessionIds` immediately below, not trusted
				// from a join, to keep that check explicit.
				or(...sessionRows.map((s) => eq(roundResult.sessionId, s.id)))
			);
		for (const row of roundRows) {
			if (!sessionIds.has(row.sessionId)) continue; // Defence-in-depth; see comment above.
			const list = roundsBySession.get(row.sessionId) ?? [];
			list.push({
				position: row.position,
				titleOk: row.titleOk,
				artistOk: row.artistOk,
				skipped: row.skipped,
				clipMs: row.clipMs,
				titleMs: row.titleMs,
				artistMs: row.artistMs,
				points: row.points,
				guessLog: row.guessLog
			});
			roundsBySession.set(row.sessionId, list);
		}
	}

	const weeklyPointsRows = await db
		.select({ week: weeklyPoints.week, points: weeklyPoints.points })
		.from(weeklyPoints)
		.where(eq(weeklyPoints.userId, userId));

	const weeklyRankRows = await db
		.select({
			week: weeklyRankSnapshot.week,
			rank: weeklyRankSnapshot.rank,
			points: weeklyRankSnapshot.points
		})
		.from(weeklyRankSnapshot)
		.where(eq(weeklyRankSnapshot.userId, userId));

	const friendshipRows = await db
		.select({
			aUserId: friendship.aUserId,
			bUserId: friendship.bUserId,
			status: friendship.status,
			requestedBy: friendship.requestedBy
		})
		.from(friendship)
		.where(or(eq(friendship.aUserId, userId), eq(friendship.bUserId, userId)));

	const friendIds = friendshipRows.map((f) => (f.aUserId === userId ? f.bUserId : f.aUserId));
	const friendNames =
		friendIds.length > 0
			? await db
					.select({ id: user.id, displayName: user.displayName })
					.from(user)
					.where(or(...friendIds.map((id) => eq(user.id, id))))
			: [];
	const nameById = new Map(friendNames.map((f) => [f.id, f.displayName]));

	const importedRows = await db
		.select({
			quizName: importedHistory.quizName,
			totalScore: importedHistory.totalScore,
			rounds: importedHistory.rounds,
			isDaily: importedHistory.isDaily,
			playedAt: importedHistory.playedAt
		})
		.from(importedHistory)
		.where(eq(importedHistory.userId, userId));

	return {
		exportedAt: now,
		profile: {
			email: profileRow.email,
			displayName: profileRow.displayName,
			avatarUrl: profileRow.avatarUrl,
			locale: profileRow.locale,
			birthYear: profileRow.birthYear,
			extendedInput: profileRow.extendedInput,
			createdAt: profileRow.createdAt.getTime()
		},
		linkedAuthProviders: authRows.map((a) => a.providerId),
		ownedQuizzes: quizRows,
		gameSessions: sessionRows.map((s) => ({
			...s,
			rounds: (roundsBySession.get(s.id) ?? []).sort((a, b) => a.position - b.position)
		})),
		weeklyPoints: weeklyPointsRows,
		weeklyRankSnapshots: weeklyRankRows,
		friendships: friendshipRows.map((f) => {
			const friendUserId = f.aUserId === userId ? f.bUserId : f.aUserId;
			return {
				friendUserId,
				friendDisplayName: nameById.get(friendUserId) ?? 'Unknown player',
				status: f.status,
				requestedByMe: f.requestedBy === userId
			};
		}),
		importedHistory: importedRows
	};
}
