/**
 * `(share)/q/[quizId]` SSR load — SHARE-1/2, plan task 3.14.
 *
 * The quiz lobby: name, round count, and (via `PlayQuiz`) straight into
 * play — no editing surface here, matching SHARE-2 ("the link does not
 * allow editing"). Server-rendered for the same unfurl reason as the
 * challenge lobby: a link-preview bot never runs client JS.
 */

import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { getQuizForLobby } from '$lib/server/quizzes/manage.js';
import { recordShareEvent } from '$lib/server/metrics.js';
import { requirePlatform } from '$lib/server/http.js';
import { parisDay } from '$lib/server/time.js';

export const load: PageServerLoad = async ({ params, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	const { quiz, roundCount } = await getQuizForLobby(db, params.quizId);
	void recordShareEvent(db, parisDay(), 'quiz_open').catch(() => {});

	return {
		quizId: quiz.id,
		quizName: quiz.name,
		description: quiz.description,
		roundCount
	};
};
