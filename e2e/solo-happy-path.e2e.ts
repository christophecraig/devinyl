/**
 * SOLO-1/2 happy path — plan task 1.30.
 *
 * A guest sets a nickname, generates a quiz, plays all ten rounds typing
 * typo'd guesses the fuzzy matcher (`src/lib/game/match.ts`) is documented to
 * accept, sees each round's reveal, and reaches the end summary with a score.
 *
 * The network is fully mocked (see `e2e/helpers/mock-api.ts`) — this test
 * never reaches Deezer or a real D1-backed session.
 */

import { expect, test } from '@playwright/test';
import { buildAnswerKey, match } from '../src/lib/game/match.js';
import { SOLO_QUIZ_TRACKS, type FixtureTrack } from './fixtures/tracks.js';
import { buildManifest } from './helpers/manifest.js';
import { mockClipRoutes, mockSessionApi } from './helpers/mock-api.js';
import {
	clickContinue,
	clickNext,
	submitGenerateForm,
	submitNickname,
	submitTextGuess
} from './helpers/play-flow.js';
import { transposedTypo } from './helpers/typos.js';

/**
 * The guess actually typed for a track: a real accepted typo when the answer
 * is long enough to tolerate one, the exact answer otherwise (e.g. "Zaz",
 * 3 normalized chars — `maxDistanceFor` grants zero tolerance there).
 * Self-verified against the same `buildAnswerKey`/`match` the client runs,
 * so a mistake here fails loudly in this test rather than surfacing as a
 * confusing "not that one" in the UI.
 */
function typedGuessFor(track: FixtureTrack): { title: string; artist: string } {
	const answers = buildAnswerKey({ title: track.title, artists: track.artists });
	const primaryArtist = track.artists[0].name;

	const title = transposedTypo(track.title) ?? track.title;
	const artist = transposedTypo(primaryArtist) ?? primaryArtist;

	expect(match(title, answers.title), `expected "${title}" to match ${track.title}`).toBe(true);
	expect(match(artist, answers.artist), `expected "${artist}" to match ${primaryArtist}`).toBe(
		true
	);

	return { title, artist };
}

test('guest plays a full quiz with typo tolerance and reaches the summary', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eHappySession01',
		quizId: 'e2eHappyQuiz01',
		tracks: SOLO_QUIZ_TRACKS,
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	const recorded = await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await submitNickname(page, 'Sonny');
	await submitGenerateForm(page, 'Stromae');

	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	await page.getByRole('button', { name: 'Start quiz' }).click();

	for (const [index, track] of SOLO_QUIZ_TRACKS.entries()) {
		const guess = typedGuessFor(track);

		await expect(
			page.getByRole('heading', { name: `Round ${index + 1} of ${SOLO_QUIZ_TRACKS.length}` })
		).toBeVisible();

		await submitTextGuess(page, 'Title', guess.title);
		await expect(page.locator('#text-answer-status-title')).toHaveText('Locked in');

		// Locking the second (last required) target ends the round immediately
		// (ROUND-3) — the "Locked in" status never has a chance to render
		// before `TextAnswer` unmounts for `RoundReveal`, so there's nothing
		// to assert on the artist field itself here.
		await submitTextGuess(page, 'Artist', guess.artist);

		// ROUND-3: both targets locked ends the round early, without waiting
		// out the 30 s clip — the reveal shows up right away.
		await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible();
		await expect(page.getByText(track.title, { exact: true })).toBeVisible();
		await expect(
			page.getByText(track.artists.map((a) => a.name).join(', '), { exact: true })
		).toBeVisible();
		await expect(page.getByText(/correct, \+\d+ pts/)).toHaveCount(2); // title + artist, both accepted

		await clickNext(page);
		await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();
		await clickContinue(page);
	}

	await expect(page.getByRole('heading', { name: 'Quiz complete' })).toBeVisible();
	await expect(page.getByText(/\d+ pts/).first()).toBeVisible();

	// The client sent one round-start beacon and one round-result per round,
	// plus exactly one finalize carrying all ten results (§7.2/§7.3).
	expect(recorded.starts.map((s) => s.position)).toEqual([...Array(10).keys()]);
	expect(recorded.results).toHaveLength(10);
	expect(recorded.finalizeBodies).toHaveLength(1);
	expect(recorded.finalizeBodies[0].rounds).toHaveLength(10);

	// Every round's guessLog records the raw (typo'd) input, unnormalized —
	// §7.3 step 1 re-runs match() against this exact text server-side.
	const firstRoundLog = recorded.results[0].guessLog;
	expect(firstRoundLog.map((g) => g.raw)).toContain(typedGuessFor(SOLO_QUIZ_TRACKS[0]).title);
});
