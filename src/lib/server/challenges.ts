/**
 * Challenges — CHAL-1…4, technical-spec §7.1/§11, plan task 3.5.
 *
 * A challenge is a thin pointer: a token, the quiz it plays, and who created
 * it. `sessions/create.ts` already knows how to start a session against a
 * `{ kind: 'challenge', token }` target (CHAL-3 — no account needed to open
 * one), and `boards.ts` already scopes a board to a `challengeToken` (CHAL-2)
 * — this module is only the create + lobby-read side.
 */

import { eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { challenge, gameSession, quiz, quizTrack } from './db/schema.js';
import { apiError } from './http.js';
import { newChallengeToken } from './ids.js';
import type { Player } from './identity.js';

/**
 * CHAL-1: "after completing any quiz" — the source session must belong to
 * the requester and be finalized. It need not be `scored`: a creator playing
 * their own quiz is always `scoredBlockReason: 'creator'`, and CREATE-3 still
 * wants that first play to be challengeable (it's what freezes the quiz's
 * content in the first place).
 */
export async function createChallenge(
	db: Db,
	input: { sessionId: string; player: Player; nickname?: string }
): Promise<{ token: string }> {
	const [session] = await db
		.select()
		.from(gameSession)
		.where(eq(gameSession.id, input.sessionId))
		.limit(1);
	if (!session) apiError('not_found', 'That session could not be found.');

	const owned =
		input.player.kind === 'user'
			? session.userId === input.player.userId
			: session.guestId === input.player.guestId;
	if (!owned) apiError('forbidden', 'That session belongs to another player.');
	if (session.finalizedAt === null) {
		apiError('conflict', 'Finish the quiz before challenging a friend.');
	}

	const token = newChallengeToken();
	await db.insert(challenge).values({
		token,
		quizId: session.quizId,
		creatorUserId: input.player.kind === 'user' ? input.player.userId : null,
		creatorGuestNickname: input.player.kind === 'guest' ? session.nickname : null,
		creatorSessionId: session.id
	});

	// CREATE-3: being challenged freezes the quiz's content, same as a scored run.
	await db.update(quiz).set({ ephemeralUntil: null }).where(eq(quiz.id, session.quizId));

	return { token };
}

export interface ChallengeLobby {
	token: string;
	quizId: string;
	quizName: string;
	rounds: number;
	challengerName: string;
	scoreToBeat: number;
}

/** CHAL-1: "sees who challenged them and the score to beat" before they start. */
export async function loadChallengeLobby(db: Db, token: string): Promise<ChallengeLobby> {
	const [row] = await db
		.select({
			token: challenge.token,
			quizId: challenge.quizId,
			quizName: quiz.name,
			creatorSessionId: challenge.creatorSessionId,
			creatorUserId: challenge.creatorUserId,
			creatorGuestNickname: challenge.creatorGuestNickname
		})
		.from(challenge)
		.innerJoin(quiz, eq(quiz.id, challenge.quizId))
		.where(eq(challenge.token, token))
		.limit(1);
	if (!row) apiError('not_found', 'This challenge link is no longer valid.');

	const [creatorSession] = row.creatorSessionId
		? await db
				.select({ nickname: gameSession.nickname, totalScore: gameSession.totalScore })
				.from(gameSession)
				.where(eq(gameSession.id, row.creatorSessionId))
				.limit(1)
		: [];

	const rounds = await countRounds(db, row.quizId);

	return {
		token: row.token,
		quizId: row.quizId,
		quizName: row.quizName,
		rounds,
		challengerName: creatorSession?.nickname ?? row.creatorGuestNickname ?? 'A friend',
		scoreToBeat: creatorSession?.totalScore ?? 0
	};
}

async function countRounds(db: Db, quizId: string): Promise<number> {
	const tracks = await db
		.select({ position: quizTrack.position })
		.from(quizTrack)
		.where(eq(quizTrack.quizId, quizId));
	return tracks.length;
}
