/**
 * Auto-generated quizzes — CREATE-5/6/7, plan task 1.13.
 *
 * A generated quiz is a **real `quiz` row** from the moment it exists, not a
 * throwaway blob: it is `kind='generated'` with `ephemeral_until = now + 24 h`,
 * so a guest can play it, challenge a friend with it, and have the link keep
 * working — the row is promoted (TTL cleared) the moment it is used or saved
 * (§6, CREATE-6). Nothing here writes the promotion; `finalize.ts` and the
 * challenge/save endpoints do.
 *
 * Two rules shape the pool logic:
 *
 *   - **Cache first, live only when thin** (§8.3). `track_cache` is warm-seeded
 *     (`scripts/seed-cache.ts`) precisely so an interactive generate doesn't
 *     stampede Deezer. A live call happens only when the cache can't fill the
 *     quiz.
 *   - **Structured filters plus a curated theme list, never open free text**
 *     (plan §G-8, `catalog/themes.ts`) — the Phase 0 probe measured raw theme
 *     search as unreliable.
 *
 * Re-rolling the same filters yields a different quiz (CREATE-7): both the
 * cache query and the live pool are randomly ordered.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CatalogTrack, QuizSettings, RoundChoices, TargetName } from '$lib/game/types.js';
import { DEFAULT_QUIZ_SETTINGS, decadeOf } from '$lib/game/types.js';
import { CURRENT_CURVE_VERSION } from '$lib/game/scoring.js';
import type { GenerationFiltersBody } from '$lib/game/schemas.js';
import type { Db } from '../db/index.js';
import { quiz, quizTrack, trackCache } from '../db/schema.js';
import type { CatalogProvider } from '../catalog/provider.js';
import { ensureTrackCached } from '../catalog/assembly.js';
import { buildRoundChoices } from '../catalog/distractors.js';
import { themeByKey } from '../catalog/themes.js';
import { newId } from '../ids.js';
import { apiError } from '../http.js';

/** CREATE-5/6: a generated quiz nobody saved evaporates after a day (§6). */
export const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many live candidates we're willing to hydrate before giving up. Each one
 * costs a `getTrack` + an availability check, and §5.2's 50 req/5 s budget is
 * shared by every player — a generate that can't fill from ~3× the round count
 * is a filter combination with no catalog behind it, not a reason to keep
 * hammering.
 */
const MAX_LIVE_HYDRATIONS_PER_ROUND = 3;

type TrackCacheRow = typeof trackCache.$inferSelect;

function targetsFor(settings: QuizSettings): TargetName[] {
	if (settings.guessTarget === 'both') return ['title', 'artist'];
	return [settings.guessTarget];
}

/**
 * Cheap path: rows we already hold, already answer-keyed, already
 * availability-checked at add time. `RANDOM()` is what makes a re-roll differ
 * (CREATE-7).
 */
async function poolFromCache(
	db: Db,
	filters: GenerationFiltersBody,
	limit: number
): Promise<TrackCacheRow[]> {
	const conditions = [isNull(trackCache.unavailableAt)];
	if (filters.genre) conditions.push(eq(trackCache.genre, filters.genre));
	if (filters.decade) conditions.push(eq(trackCache.decade, filters.decade));

	// An artist or theme filter has no cache-side equivalent — genre and decade
	// are the only indexed dimensions (`idx_track_genre_decade`). Rather than
	// scan the table with a LIKE, those filters go straight live.
	if (filters.artist || filters.theme) return [];

	return db
		.select()
		.from(trackCache)
		.where(and(...conditions))
		.orderBy(sql`RANDOM()`)
		.limit(limit);
}

/** Live path, per filter kind. Results are lightweight (§5.2) — hydration happens in `ensureTrackCached`. */
async function poolFromProvider(
	provider: CatalogProvider,
	filters: GenerationFiltersBody,
	limit: number
): Promise<CatalogTrack[]> {
	if (filters.theme) {
		const theme = themeByKey(filters.theme);
		// Unreachable via the API (the schema-checked key is looked up before we
		// get here), but a direct caller passing junk should not fall through to
		// an unvetted search.
		if (!theme) return [];
		return provider.searchTracks(theme.query, { limit });
	}

	return provider.poolForFilters({
		seed: filters.artist ?? null,
		genre: filters.genre ?? null,
		decade: filters.decade ?? null,
		rounds: filters.rounds
	});
}

function shuffle<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

export interface GenerateResult {
	quizId: string;
	rounds: number;
	settings: QuizSettings;
	ephemeralUntil: number;
}

/**
 * Assemble and persist a generated quiz. Throws a 4xx (via `apiError`) when the
 * filters describe a corner of the catalog too thin to fill — a short quiz
 * silently delivered instead of the requested length would be a worse answer
 * than an honest "try different filters".
 */
export async function generateQuiz(
	db: Db,
	provider: CatalogProvider,
	filters: GenerationFiltersBody,
	opts: { now?: number } = {}
): Promise<GenerateResult> {
	const now = opts.now ?? Date.now();
	const settings: QuizSettings = { ...DEFAULT_QUIZ_SETTINGS, ...filters.settings };

	const chosen: TrackCacheRow[] = [];
	const seen = new Set<string>();

	const take = (row: TrackCacheRow): void => {
		if (seen.has(row.id) || chosen.length >= filters.rounds) return;
		seen.add(row.id);
		chosen.push(row);
	};

	for (const row of await poolFromCache(db, filters, filters.rounds * 3)) take(row);

	if (chosen.length < filters.rounds) {
		const candidates = shuffle(
			await poolFromProvider(provider, filters, filters.rounds * MAX_LIVE_HYDRATIONS_PER_ROUND)
		);

		let hydrations = 0;
		const budget = filters.rounds * MAX_LIVE_HYDRATIONS_PER_ROUND;

		for (const candidate of candidates) {
			if (chosen.length >= filters.rounds || hydrations >= budget) break;
			if (seen.has(candidate.providerId)) continue;

			hydrations++;
			// This is also where MUS-5 is enforced at source: a track whose preview
			// won't play is never written into a quiz.
			const cached = await ensureTrackCached(db, provider, candidate.providerId);
			if (!cached.ok) continue;

			// Decade can only be checked after hydration — search results carry no
			// release date (§5.2), which is why the filter is applied here rather
			// than in the provider query.
			if (filters.decade && decadeOf(cached.row.releaseYear) !== filters.decade) continue;

			take(cached.row as TrackCacheRow);
		}
	}

	if (chosen.length < filters.rounds) {
		apiError(
			'not_found',
			`We could only find ${chosen.length} playable tracks for those filters — try widening them.`
		);
	}

	const quizId = newId();
	const targets = targetsFor(settings);

	// Choices are computed at assembly and frozen forever (QUIZ-6); only their
	// display order is shuffled, per session, client-side.
	const choicesByPosition: (RoundChoices | null)[] = [];
	for (const row of chosen) {
		choicesByPosition.push(
			settings.answerMode === 'choice'
				? await buildRoundChoices(db, row, targets, { provider })
				: null
		);
	}

	await db.insert(quiz).values({
		id: quizId,
		ownerId: null,
		kind: 'generated',
		name: describeFilters(filters),
		description: null,
		guessTarget: settings.guessTarget,
		answerMode: settings.answerMode,
		scoringMode: settings.scoringMode,
		choiceRetryMode: settings.choiceRetryMode,
		choiceRetryPenaltySeconds: settings.choiceRetryPenaltySeconds,
		curveVersion: CURRENT_CURVE_VERSION,
		ephemeralUntil: now + EPHEMERAL_TTL_MS,
		createdAt: now,
		updatedAt: now
	});

	await db.insert(quizTrack).values(
		chosen.map((row, position) => ({
			quizId,
			position,
			trackId: row.id,
			choices: choicesByPosition[position]
		}))
	);

	return {
		quizId,
		rounds: chosen.length,
		settings,
		ephemeralUntil: now + EPHEMERAL_TTL_MS
	};
}

/**
 * A generated quiz still needs a name — it shows up in a challenge lobby and on
 * a board. Built from the filters rather than translated: LOC-2 keeps catalog
 * metadata (artist and genre names) untranslated, and this string is mostly
 * catalog metadata. A saved quiz (CREATE-6) can be renamed by its new owner.
 */
function describeFilters(filters: GenerationFiltersBody): string {
	const parts: string[] = [];
	if (filters.artist) parts.push(filters.artist);
	if (filters.theme) parts.push(themeByKey(filters.theme)?.labelFr ?? filters.theme);
	if (filters.genre) parts.push(filters.genre);
	if (filters.decade) parts.push(`${filters.decade}s`);
	return parts.join(' · ') || 'Blind test';
}
