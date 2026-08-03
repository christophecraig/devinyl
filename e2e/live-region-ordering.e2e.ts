/**
 * Live-region ordering — A11Y-2/3, plan task 1.30.
 *
 * This is an *audio* game (ROUND-2: no pause/replay), so a screen reader
 * talking over the clip doesn't just annoy, it destroys the thing being
 * tested. `src/lib/client/a11y.svelte.ts`'s `Announcer` exists specifically
 * to hold the reveal announcement until the clip actually ends
 * (`deferUntilGap`) rather than the instant the `reveal` phase is entered.
 *
 * This test lets one round's clip play to its **natural end** (no early
 * lock — see the short 5 s tone fixture) and records every mutation of both
 * `aria-live` regions with a timestamp, via a `MutationObserver` injected
 * before the round starts. It then asserts, from that recorded log:
 *
 *   1. `assertive` carries the countdown ticks, "Clip playing", and "Clip
 *      ended" (A11Y-2's split).
 *   2. `polite` carries the reveal, and it never appears before "Clip ended"
 *      lands in `assertive` — the actual A11Y-2 guarantee, not just "the
 *      text eventually shows up".
 *   3. `polite` also carries the scoreboard announcement, and only after the
 *      player advances past the reveal.
 */

import { expect, test } from '@playwright/test';
import { SHORT_CLIP_TRACK } from './fixtures/tracks.js';
import { buildManifest } from './helpers/manifest.js';
import { mockClipRoutes, mockSessionApi } from './helpers/mock-api.js';
import { submitGenerateForm, submitNickname } from './helpers/play-flow.js';

interface AnnouncementLogEntry {
	politeness: 'assertive' | 'polite';
	/** Trailing zero-width space nonce (a11y.svelte.ts's anti-dedup trick) stripped. */
	text: string;
	t: number;
}

/**
 * Installs a `MutationObserver` on both live regions and returns a getter for
 * the log. Must run before the round that's being observed starts — both
 * regions are always-mounted (`LiveRegion.svelte`'s module doc), so this is
 * safe to call right after the play route's shell renders.
 */
async function captureAnnouncements(
	page: import('@playwright/test').Page
): Promise<() => Promise<AnnouncementLogEntry[]>> {
	await page.evaluate(() => {
		const log: { politeness: string; text: string; t: number }[] = [];
		(window as unknown as { __e2eAnnouncements: typeof log }).__e2eAnnouncements = log;

		const watch = (el: Element, politeness: string): void => {
			const record = (): void => {
				log.push({ politeness, text: el.textContent ?? '', t: performance.now() });
			};
			new MutationObserver(record).observe(el, {
				childList: true,
				characterData: true,
				subtree: true
			});
		};

		const [assertiveEl, politeEl] = document.querySelectorAll('[aria-live]');
		watch(assertiveEl, 'assertive');
		watch(politeEl, 'polite');
	});

	return async () => {
		const raw = await page.evaluate(
			() => (window as unknown as { __e2eAnnouncements: AnnouncementLogEntry[] }).__e2eAnnouncements
		);
		// Strip the anti-dedup zero-width-space nonce so text comparisons below
		// read naturally.
		return raw.map((entry) => ({ ...entry, text: entry.text.replace(/\u200b$/, '') }));
	};
}

test('the reveal announcement lands at clip end, never during playback', async ({ page }) => {
	const manifest = await buildManifest({
		sessionId: 'e2eLiveRegionSession01',
		quizId: 'e2eLiveRegionQuiz01',
		tracks: [SHORT_CLIP_TRACK],
		settings: { guessTarget: 'both', answerMode: 'text', scoringMode: 'speed' }
	});
	await mockSessionApi(page, { quizId: manifest.quizId, manifest });
	await mockClipRoutes(page);

	await page.goto('/');
	await submitNickname(page, 'Listener');
	await submitGenerateForm(page, SHORT_CLIP_TRACK.artists[0].name);

	await expect(page.getByRole('heading', { name: 'Ready to play?' })).toBeVisible();
	const getLog = await captureAnnouncements(page);
	await page.getByRole('button', { name: 'Start quiz' }).click();

	// Never lock a target — the clip must run to its natural end (its buffer
	// is the deliberately-short 5 s tone, task 1.29) for `notifyClipEnded()`
	// to be what closes the round, not an early ROUND-3 lock.
	await expect(page.getByRole('heading', { name: 'Reveal' })).toBeVisible({ timeout: 20_000 });

	const log = await getLog();

	const assertiveTexts = log.filter((e) => e.politeness === 'assertive').map((e) => e.text);
	const politeTexts = log.filter((e) => e.politeness === 'polite').map((e) => e.text);

	// A11Y-2's split: countdown/clip-start/clip-end are assertive.
	expect(assertiveTexts).toEqual(
		expect.arrayContaining(['3', '2', '1', 'Clip playing', 'Clip ended'])
	);
	// The reveal is polite, carrying the track's title.
	expect(politeTexts.some((t) => t.startsWith(`Reveal: ${SHORT_CLIP_TRACK.title}`))).toBe(true);

	const clipEndedAt = log.find((e) => e.politeness === 'assertive' && e.text === 'Clip ended')?.t;
	const revealAt = log.find((e) => e.politeness === 'polite' && e.text.startsWith('Reveal:'))?.t;
	expect(clipEndedAt, 'expected a "Clip ended" assertive announcement').not.toBeUndefined();
	expect(revealAt, 'expected a "Reveal: ..." polite announcement').not.toBeUndefined();

	// The actual A11Y-2 guarantee: the reveal never lands before clip end —
	// not "eventually both appear", but strictly ordered.
	expect(revealAt! >= clipEndedAt!).toBe(true);

	// And nothing polite at all was announced before "Clip ended" — the
	// reveal genuinely waited for the gap rather than merely being logged
	// after it by coincidence of async timing.
	const politeBeforeClipEnd = log.filter((e) => e.politeness === 'polite' && e.t < clipEndedAt!);
	expect(politeBeforeClipEnd).toEqual([]);

	// Advance past the reveal — the scoreboard announcement (also polite)
	// must only appear now, after the player's own action, never earlier.
	expect(politeTexts.some((t) => t.startsWith('Round 1 of 1. Score so far'))).toBe(false);
	await page.getByRole('button', { name: 'Next' }).click();
	await expect(page.getByRole('heading', { name: 'Score so far' })).toBeVisible();

	const logAfterAdvance = await getLog();
	expect(
		logAfterAdvance.some(
			(e) => e.politeness === 'polite' && e.text.startsWith('Round 1 of 1. Score so far')
		)
	).toBe(true);
});
