/**
 * Distractor pools — technical-spec §8.3, ANS-6, plan task 1.11.
 *
 * "The pool is cached, not fetched live." A guest generating a 10-round
 * choice-mode quiz on the interactive path must not fire dozens of calls
 * against Deezer — that's the entire reason `track_cache` exists and is
 * warm-seeded (`scripts/seed-cache.ts`, task 1.12). This module draws
 * candidates from `track_cache`, indexed by `(genre, decade)`
 * (`idx_track_genre_decade`, `schema.ts`), and only reaches for a live
 * provider call when a bucket is too thin to yield clean distractors.
 *
 * Choices stored in `quiz_track.choices` are **fixed forever** (QUIZ-6) — only
 * the display order is shuffled, per session, client-side. Nothing in this
 * module shuffles anything; it picks and returns a stable set.
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { normalize } from '$lib/game/normalize.js';
import type { GenerationFilters, RoundChoices, TargetName } from '$lib/game/types.js';
import type { Db } from '../db/index.js';
import { trackCache } from '../db/schema.js';
import type { CatalogProvider } from './provider.js';

const DEFAULT_DISTRACTOR_COUNT = 3;
/** How many candidate rows to pull per cache-query tier before filtering — generous so filtering rarely starves the pick. */
const POOL_QUERY_LIMIT = 30;

type TrackCacheRow = typeof trackCache.$inferSelect;

function primaryArtistName(row: Pick<TrackCacheRow, 'artists'>): string | null {
	const primary = row.artists.find((a) => a.primary) ?? row.artists[0];
	return primary?.name ?? null;
}

function displayTextFor(
	row: Pick<TrackCacheRow, 'titleShort' | 'title' | 'artists'>,
	target: TargetName
): string | null {
	if (target === 'title') return row.titleShort || row.title || null;
	return primaryArtistName(row);
}

/**
 * Query tiers in preference order (§8.3: "prefer same decade, then same
 * genre"). Each tier excludes the correct track and anything the availability
 * job has already flagged dead (`unavailable_at`) — a distractor never plays,
 * but showing a pulled title as an option is still a worse experience than
 * not offering it.
 */
async function queryCacheTiers(
	db: Db,
	excludeTrackId: string,
	genre: string | null,
	decade: number | null
): Promise<TrackCacheRow[][]> {
	const base = and(ne(trackCache.id, excludeTrackId), isNull(trackCache.unavailableAt));

	const tiers: Promise<TrackCacheRow[]>[] = [];

	if (decade !== null) {
		tiers.push(
			db
				.select()
				.from(trackCache)
				.where(and(base, eq(trackCache.decade, decade)))
				.orderBy(sql`RANDOM()`)
				.limit(POOL_QUERY_LIMIT)
		);
	}
	if (genre !== null) {
		tiers.push(
			db
				.select()
				.from(trackCache)
				.where(and(base, eq(trackCache.genre, genre)))
				.orderBy(sql`RANDOM()`)
				.limit(POOL_QUERY_LIMIT)
		);
	}
	tiers.push(
		db
			.select()
			.from(trackCache)
			.where(base)
			.orderBy(sql`RANDOM()`)
			.limit(POOL_QUERY_LIMIT)
	);

	return Promise.all(tiers);
}

export interface PickDistractorsOptions {
	db: Db;
	target: TargetName;
	/** The correct track's namespaced id — never offered as its own distractor. */
	excludeTrackId: string;
	/** Normalized accepted forms for the correct answer — a candidate colliding with any of these is dropped. */
	correctForms: readonly string[];
	genre: string | null;
	decade: number | null;
	count?: number;
	/**
	 * When supplied, used as the thin-bucket live fallback (§8.3's "live calls
	 * happen only when a bucket is too thin"). Omit to restrict a pick to the
	 * cache only (e.g. tests, or a caller that wants to know the cache alone
	 * was insufficient).
	 */
	provider?: CatalogProvider;
}

/**
 * Picks up to `count` (default 3) distinct, non-colliding distractor display
 * strings for one guess target. May return fewer than `count` if both the
 * cache and the live fallback are exhausted — callers decide how to handle
 * that (e.g. widen the pool, fall back to a smaller quiz).
 */
export async function pickDistractors(opts: PickDistractorsOptions): Promise<string[]> {
	const count = opts.count ?? DEFAULT_DISTRACTOR_COUNT;
	const chosen: string[] = [];
	const usedNormalized = new Set<string>(opts.correctForms.filter(Boolean));

	function tryAdd(display: string | null): void {
		if (!display || chosen.length >= count) return;
		const norm = normalize(display);
		if (!norm || usedNormalized.has(norm)) return;
		usedNormalized.add(norm);
		chosen.push(display);
	}

	const tiers = await queryCacheTiers(opts.db, opts.excludeTrackId, opts.genre, opts.decade);
	for (const tier of tiers) {
		for (const row of tier) {
			if (chosen.length >= count) break;
			tryAdd(displayTextFor(row, opts.target));
		}
		if (chosen.length >= count) break;
	}

	if (chosen.length < count && opts.provider) {
		const filters: GenerationFilters = {
			genre: opts.genre,
			decade: opts.decade,
			rounds: count * 4 // ask for a generous pool since filtering will drop some
		};
		try {
			const live = await opts.provider.poolForFilters(filters);
			for (const track of live) {
				if (chosen.length >= count) break;
				if (track.providerId === opts.excludeTrackId) continue;
				const display =
					opts.target === 'title'
						? track.titleShort || track.title
						: primaryArtistNameFromCatalog(track);
				tryAdd(display);
			}
		} catch (err) {
			// Same "scarce catalog" degradation as generate.ts's own live-pool
			// fallback: a bucket too thin to fill live (e.g. the Workers
			// subrequest cap) yields fewer distractors, not a crash.
			console.error('[distractors] live pool fallback failed', err);
		}
	}

	return chosen;
}

function primaryArtistNameFromCatalog(track: {
	artists: { name: string; primary: boolean }[];
}): string | null {
	const primary = track.artists.find((a) => a.primary) ?? track.artists[0];
	return primary?.name ?? null;
}

/**
 * Convenience for quiz assembly: builds the full `RoundChoices` for a track —
 * distractors plus the correct display text — for every target the quiz's
 * `guessTarget` setting calls for. The correct answer's *display* text (not
 * its normalized form) is included alongside the 3 distractors, matching
 * `quiz_track.choices`' "4 options per target" shape (`schema.ts`); which one
 * is correct is never marked in this array — that's exactly the point (ANS-5:
 * the UI never leaks which option is right before a pick).
 */
export async function buildRoundChoices(
	db: Db,
	correctRow: Pick<
		TrackCacheRow,
		'id' | 'title' | 'titleShort' | 'artists' | 'genre' | 'decade' | 'answers'
	>,
	targets: readonly TargetName[],
	opts: { provider?: CatalogProvider; count?: number } = {}
): Promise<RoundChoices> {
	const choices: RoundChoices = {};

	for (const target of targets) {
		const correctDisplay = displayTextFor(correctRow, target);
		const correctForms = target === 'title' ? correctRow.answers.title : correctRow.answers.artist;

		const distractors = await pickDistractors({
			db,
			target,
			excludeTrackId: correctRow.id,
			correctForms,
			genre: correctRow.genre,
			decade: correctRow.decade,
			count: opts.count,
			provider: opts.provider
		});

		const options = correctDisplay ? [correctDisplay, ...distractors] : distractors;
		if (target === 'title') choices.title = options;
		else choices.artist = options;
	}

	return choices;
}
