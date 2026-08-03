/**
 * Network interception for the solo-play e2e suite (plan task 1.30).
 *
 * These tests must never hit Deezer or a real D1-backed worker route.
 * Everything is intercepted at the Playwright level (`page.route`), *before*
 * the request leaves the browser, so the SvelteKit/Workers server behind
 * `pnpm run preview` never has to see these calls at all:
 *
 *   - `POST /api/quizzes/generate` / `POST /api/sessions` → a canned
 *     `SessionManifest` built by `../helpers/manifest.ts` with the real
 *     `sealRoundPack` crypto.
 *   - clip URLs (namespaced under `/e2e-clip/`, see `manifest.ts`) → the
 *     committed tone WAVs in `e2e/fixtures/`.
 *   - the round-start beacon, round-result, and finalize endpoints → recorded
 *     (so tests can assert what the client sent) and answered with the real
 *     response shapes (204 / a `FinalizeResult`).
 *
 * Finalize's score is computed with the app's own `getCurve()` (from
 * `src/lib/game/scoring.ts`) over whatever `lockTimes`/`clipMs` the client
 * actually submitted, rather than a hand-picked number — that keeps the
 * summary screen's server-confirmed total consistent with what the same
 * player run would score for real, without this test file re-deriving the
 * curve's shape itself.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { getCurve } from '../../src/lib/game/scoring.js';
import type { FinalizeSessionBody } from '../../src/lib/game/schemas.js';
import type {
	FinalizedRound,
	FinalizeResult,
	RoundResultPayload,
	SessionManifest
} from '../../src/lib/game/types.js';
import { CLIP_ROUTE_PREFIX } from './manifest.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export interface RecordedCalls {
	starts: { position: number }[];
	results: RoundResultPayload[];
	finalizeBodies: FinalizeSessionBody[];
}

/** Escapes a session id for use inside a Playwright glob route pattern. */
function escapeGlob(value: string): string {
	return value.replace(/[*?[\]]/g, '\\$&');
}

function computeFinalizeResult(
	manifest: SessionManifest,
	rounds: RoundResultPayload[]
): FinalizeResult {
	const curve = getCurve(manifest.curveVersion);
	let totalScore = 0;

	const finalizedRounds: FinalizedRound[] = rounds.map((r) => {
		const titleMs = r.lockTimes.title ?? null;
		const artistMs = r.lockTimes.artist ?? null;
		const titlePoints =
			!r.skipped && titleMs !== null
				? curve.points(manifest.effectiveScoringMode, titleMs, r.clipMs)
				: 0;
		const artistPoints =
			!r.skipped && artistMs !== null
				? curve.points(manifest.effectiveScoringMode, artistMs, r.clipMs)
				: 0;
		const points = titlePoints + artistPoints;
		totalScore += points;

		return {
			position: r.position,
			titleOk: r.skipped ? null : titleMs !== null,
			artistOk: r.skipped ? null : artistMs !== null,
			skipped: r.skipped,
			clipMs: r.clipMs,
			titleMs,
			artistMs,
			points
		};
	});

	return {
		sessionId: manifest.sessionId,
		totalScore,
		rounds: finalizedRounds,
		scored: true,
		scoredBlockReason: null,
		effectiveScoringMode: manifest.effectiveScoringMode,
		curveVersion: manifest.curveVersion,
		finalizedAt: Date.now()
	};
}

/**
 * Wires up every route this suite needs and returns the running log of what
 * the client sent — tests read `recorded` after driving the UI to assert on
 * it (e.g. "the round-result beacon carried the typo'd guess in guessLog").
 */
export async function mockSessionApi(
	page: Page,
	opts: { quizId: string; manifest: SessionManifest }
): Promise<RecordedCalls> {
	const recorded: RecordedCalls = { starts: [], results: [], finalizeBodies: [] };
	const sid = escapeGlob(opts.manifest.sessionId);

	await page.route('**/api/quizzes/generate', async (route) => {
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify({ quizId: opts.quizId })
		});
	});

	await page.route('**/api/sessions', async (route) => {
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify(opts.manifest)
		});
	});

	await page.route(`**/api/sessions/${sid}/rounds/*/start`, async (route) => {
		const match = /\/rounds\/(\d+)\/start/.exec(route.request().url());
		recorded.starts.push({ position: match ? Number(match[1]) : -1 });
		await route.fulfill({ status: 204 });
	});

	await page.route(`**/api/sessions/${sid}/rounds/*/result`, async (route) => {
		recorded.results.push(route.request().postDataJSON() as RoundResultPayload);
		await route.fulfill({ status: 204 });
	});

	await page.route(`**/api/sessions/${sid}/finalize`, async (route) => {
		const body = route.request().postDataJSON() as FinalizeSessionBody;
		recorded.finalizeBodies.push(body);
		// §7.3: finalize is the authority, but the client's own `submitFinalize`
		// always sends the full `rounds` it collected, so preferring the body
		// mirrors production and only falls back to the beacon log in case a
		// test drives finalize without a body (it never should).
		const rounds = body.rounds ?? recorded.results;
		const result = computeFinalizeResult(opts.manifest, rounds);
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(result)
		});
	});

	return recorded;
}

/** Serves the committed tone WAVs (task 1.29) for every `/e2e-clip/...` URL a manifest points at. */
export async function mockClipRoutes(page: Page): Promise<void> {
	await page.route(`**${CLIP_ROUTE_PREFIX}/*`, async (route) => {
		const url = new URL(route.request().url());
		const basename = url.pathname.split('/').pop() ?? '';
		// Strip the `<position>-` prefix `manifest.ts`'s `clipUrlFor` adds to
		// keep URLs unique per round even when two rounds share a tone file.
		const filename = basename.replace(/^\d+-/, '');
		const data = readFileSync(path.join(FIXTURES_DIR, filename));
		await route.fulfill({ status: 200, contentType: 'audio/wav', body: data });
	});
}
