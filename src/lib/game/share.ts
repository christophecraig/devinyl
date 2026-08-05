/**
 * Spoiler-free share text — DAILY-3, SHARE-4, plan task 3.3.
 *
 * Pure and isomorphic (no I/O), same as the rest of `$lib/game` — testable
 * without a server, and reusable from both the client (Share API/clipboard)
 * and anywhere server-rendered text needs the identical string (unfurl
 * descriptions, task 3.14). The one rule every function here exists to
 * enforce: **never a track name, title, or artist.** A daily share is a
 * Wordle-style grid, not a spoiler.
 */

import type { FinalizedRound } from './types.js';
import { m } from '$lib/paraglide/messages.js';

/** ROUND-4-shaped emoji per round: green = both correct, yellow = partial, red = missed/skipped. */
function roundEmoji(round: Pick<FinalizedRound, 'skipped' | 'titleOk' | 'artistOk'>): string {
	if (round.skipped) return '⬛';
	const hasTitle = round.titleOk !== null;
	const hasArtist = round.artistOk !== null;
	const gotTitle = round.titleOk === true;
	const gotArtist = round.artistOk === true;

	const relevantCount = (hasTitle ? 1 : 0) + (hasArtist ? 1 : 0);
	const gotCount = (gotTitle ? 1 : 0) + (gotArtist ? 1 : 0);

	if (relevantCount === 0) return '⬛';
	if (gotCount === relevantCount) return '🟩';
	if (gotCount === 0) return '🟥';
	return '🟨';
}

export interface DailyShareInput {
	dayNumber: number;
	totalScore: number;
	rounds: Pick<FinalizedRound, 'skipped' | 'titleOk' | 'artistOk'>[];
	/** Locale-appropriate product name/URL line, kept outside this function so it's the caller's one string to localize. */
	url: string;
}

/** DAILY-3: score, day number, per-round emoji row — never track names. */
export function buildDailyShareText(input: DailyShareInput): string {
	const emojiRow = input.rounds.map(roundEmoji).join('');
	const heading = m.share_daily_text({ day: input.dayNumber, score: input.totalScore });
	return `${heading}\n${emojiRow}\n${input.url}`;
}

export interface ChallengeShareInput {
	challengerName: string;
	scoreToBeat: number;
	url: string;
}

/** SHARE-4: challenge previews may show the challenger's nickname and score to beat — never track data. */
export function buildChallengeShareText(input: ChallengeShareInput): string {
	const heading = m.share_challenge_text({
		name: input.challengerName,
		score: input.scoreToBeat
	});
	return `${heading}\n${input.url}`;
}
