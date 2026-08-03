/**
 * Quiz-assembly track caching — technical-spec §5.4, MUS-5, plan task 1.10.
 *
 * Two things happen once, at the moment a track is added to a quiz (manual
 * add, generation, or official curation) — never at play time:
 *
 *   1. **Answer keys** are precomputed via the shared `buildAnswerKey` (§8.4) —
 *      never reimplemented here. They're computed from title/artist *strings*,
 *      not the provider id, so they survive a provider swap untouched (§G-15).
 *   2. **Availability is enforced.** Adding a track requires its preview URL to
 *      return HTTP 200/206 with a plausible duration (`availability.ts`). A
 *      track that fails is refused with a creator-facing message — a quiz must
 *      never be saved containing a known-dead clip.
 */

import { eq } from 'drizzle-orm';
import type { CatalogTrack } from '$lib/game/types.js';
import { decadeOf } from '$lib/game/types.js';
import { buildAnswerKey } from '$lib/game/match.js';
import type { Db } from '../db/index.js';
import { trackCache } from '../db/schema.js';
import type { CatalogProvider } from './provider.js';
import { checkPreviewAvailability } from './availability.js';

/** The exact shape of one `track_cache` row (mirrors `schema.ts`'s `trackCache` table). */
export interface TrackCacheRow {
	id: string;
	provider: string;
	providerTrackId: string;
	title: string;
	titleShort: string;
	artists: { name: string; primary: boolean }[];
	albumTitle: string | null;
	coverUrl: string | null;
	releaseYear: number | null;
	genre: string | null;
	decade: number | null;
	answers: { title: string[]; artist: string[] };
	previewMs: number | null;
	fetchedAt: number;
	unavailableAt: number | null;
}

/**
 * Builds the full `track_cache` insert row for a hydrated catalog track
 * (§5.4): namespaced id split into `(provider, providerTrackId)`, decade
 * derived from `releaseYear` (never stored redundantly by the caller — this
 * is the one place it's computed), and answers computed via the shared
 * `buildAnswerKey` — normalization itself is never reimplemented here.
 */
export function buildTrackCacheRow(
	track: CatalogTrack,
	opts: { previewMs: number | null; fetchedAt?: number }
): TrackCacheRow {
	const sep = track.providerId.indexOf(':');
	if (sep <= 0) {
		throw new Error(
			`CatalogTrack.providerId must be namespaced ("provider:id"), got "${track.providerId}"`
		);
	}
	const provider = track.providerId.slice(0, sep);
	const providerTrackId = track.providerId.slice(sep + 1);

	return {
		id: track.providerId,
		provider,
		providerTrackId,
		title: track.title,
		titleShort: track.titleShort,
		artists: track.artists.map((a) => ({ name: a.name, primary: a.primary })),
		albumTitle: track.albumTitle || null,
		coverUrl: track.coverUrl,
		releaseYear: track.releaseYear,
		genre: track.genre,
		decade: decadeOf(track.releaseYear),
		answers: buildAnswerKey({
			title: track.title,
			titleShort: track.titleShort,
			artists: track.artists
		}),
		previewMs: opts.previewMs,
		fetchedAt: opts.fetchedAt ?? Date.now(),
		unavailableAt: null
	};
}

/** Why a track was refused at assembly time — surfaced to the creator (MUS-5). */
export type TrackCacheRefusalReason = 'not_found' | 'no_preview' | 'preview_unavailable';

export type EnsureTrackCachedResult =
	| { ok: true; row: TrackCacheRow }
	| { ok: false; reason: TrackCacheRefusalReason; message: string };

/**
 * Resolves, availability-checks, and upserts one track into `track_cache`.
 * This is the function quiz assembly (manual add — task 2.6, generation —
 * task 1.13, official curation) is meant to call: it is the single place
 * MUS-5's add-time refusal is enforced, so no caller can accidentally save a
 * quiz around it.
 *
 * `id` may be a bare or namespaced provider id — `provider.getTrack` already
 * accepts both.
 */
export async function ensureTrackCached(
	db: Db,
	provider: CatalogProvider,
	id: string,
	opts: { fetchImpl?: typeof fetch } = {}
): Promise<EnsureTrackCachedResult> {
	const track = await provider.getTrack(id);
	if (!track) {
		return {
			ok: false,
			reason: 'not_found',
			message: 'This track could not be found in the catalog.'
		};
	}

	const previewUrl = await provider.getPreviewUrl(track.providerId);
	if (!previewUrl) {
		return {
			ok: false,
			reason: 'no_preview',
			message: `"${track.title}" has no preview clip available and can't be added.`
		};
	}

	const availability = await checkPreviewAvailability(previewUrl, opts.fetchImpl);
	if (!availability.ok) {
		return {
			ok: false,
			reason: 'preview_unavailable',
			message: `"${track.title}"'s preview clip isn't playable right now and can't be added.`
		};
	}

	const row = buildTrackCacheRow(track, { previewMs: availability.durationMs });
	await upsertTrackCache(db, row);
	return { ok: true, row };
}

/** Idempotent upsert — re-adding an already-cached track refreshes its metadata rather than erroring. */
export async function upsertTrackCache(db: Db, row: TrackCacheRow): Promise<void> {
	await db
		.insert(trackCache)
		.values(row)
		.onConflictDoUpdate({
			target: trackCache.id,
			set: {
				title: row.title,
				titleShort: row.titleShort,
				artists: row.artists,
				albumTitle: row.albumTitle,
				coverUrl: row.coverUrl,
				releaseYear: row.releaseYear,
				genre: row.genre,
				decade: row.decade,
				answers: row.answers,
				previewMs: row.previewMs,
				fetchedAt: row.fetchedAt,
				unavailableAt: row.unavailableAt
			}
		});
}

/** Convenience read used by `distractors.ts` and `seed-cache.ts` — kept here so both share one query shape. */
export async function getCachedTrack(db: Db, id: string) {
	const rows = await db.select().from(trackCache).where(eq(trackCache.id, id)).limit(1);
	return rows[0] ?? null;
}
