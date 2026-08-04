/**
 * Deezer catalog provider — technical-spec §5.1–§5.2, plan tasks 1.9/1.10.
 *
 * Public API, no key required for the reads this app makes (§5.2). All calls
 * are server-side (also sidesteps CORS on the API itself — only the CDN
 * preview needs browser CORS, verified separately in the Phase 0 probe).
 *
 * Quirk worth documenting because it breaks the obvious `!res.ok` check:
 * Deezer answers unresolvable ids with **HTTP 200** and an `{ error: {...} }`
 * body (verified live against `/track/999999999999999`), not a 404. Every JSON
 * fetch here checks the body shape, not just the status code.
 */

import type { CatalogTrack, CreditedArtist, GenerationFilters } from '$lib/game/types.js';
import type { CatalogProvider } from './provider.js';
import { namespacedId, resolveBareId } from './provider.js';
import { Throttle, type ThrottleOptions } from './throttle.js';
import type {
	DeezerAlbumFull,
	DeezerArtistSearchResult,
	DeezerChartTracksResponse,
	DeezerErrorResponse,
	DeezerGenreListResponse,
	DeezerSearchArtistResponse,
	DeezerSearchTrackResponse,
	DeezerTrackFull,
	DeezerTrackSummary
} from './deezer-types.js';

const DEEZER_BASE = 'https://api.deezer.com';
const PROVIDER_NAME = 'deezer';

/** Search-response TTL in the Workers Cache API (§5.3). */
const SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;

function isErrorBody(body: unknown): body is DeezerErrorResponse {
	return typeof body === 'object' && body !== null && 'error' in body;
}

/**
 * The two Cache API methods this module actually uses.
 *
 * Structural rather than the `Cache` lib type on purpose: the Workers runtime's
 * `caches.default` implements a *subset* of the DOM `Cache` interface (no
 * `add`, `addAll`, `keys`, `matchAll`), so annotating it as DOM `Cache` makes
 * `platform.caches.default` fail to typecheck at the call site.
 */
export interface ReadThroughCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

export interface DeezerProviderOptions {
	/** Defaults to the ambient `fetch` — injected in tests so nothing here ever hits the network (§17). */
	fetch?: typeof fetch;
	/**
	 * The Workers Cache API instance to use for the §5.3 24 h search cache
	 * (typically `platform.caches.default`). Deliberately **not** read from a
	 * global — `caches.default` only exists in the real Workers runtime, and
	 * the unit-test project (`vite.config.ts`, `environment: 'node'`) has no
	 * such global. Omit it to run uncached (tests; local dev without a Cache
	 * binding).
	 */
	cache?: ReadThroughCache;
	throttle?: ThrottleOptions;
}

export class DeezerProvider implements CatalogProvider {
	readonly name = PROVIDER_NAME;

	private readonly fetchImpl: typeof fetch;
	private readonly cache: ReadThroughCache | undefined;
	private readonly throttle: Throttle;

	constructor(opts: DeezerProviderOptions = {}) {
		this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
		this.cache = opts.cache;
		this.throttle = new Throttle(opts.throttle);
	}

	// -------------------------------------------------------------------------
	// CatalogProvider
	// -------------------------------------------------------------------------

	async searchTracks(q: string, opts: { limit?: number } = {}): Promise<CatalogTrack[]> {
		const url = buildUrl('/search/track', { q, limit: opts.limit });
		const body = await this.getJsonCached<DeezerSearchTrackResponse>(url);
		if (!body) return [];
		return body.data.map(summaryToCatalogTrack);
	}

	async getTrack(providerTrackId: string): Promise<CatalogTrack | null> {
		const bareId = resolveBareId(PROVIDER_NAME, providerTrackId);
		const track = await this.getJson<DeezerTrackFull>(
			buildUrl(`/track/${encodeURIComponent(bareId)}`)
		);
		if (!track) return null;

		const album = track.album?.id
			? await this.getJson<DeezerAlbumFull>(buildUrl(`/album/${track.album.id}`))
			: null;

		return fullTrackToCatalogTrack(track, album);
	}

	async getPreviewUrl(providerTrackId: string): Promise<string | null> {
		const bareId = resolveBareId(PROVIDER_NAME, providerTrackId);
		// A lighter fetch than getTrack(): no album hydration, just the current
		// preview URL. Never cached — §5.2's whole point is these expire.
		const track = await this.getJson<DeezerTrackFull>(
			buildUrl(`/track/${encodeURIComponent(bareId)}`)
		);
		return track?.preview ?? null;
	}

	/**
	 * CREATE-5 live generation pool. Deezer's chart/top/search endpoints carry
	 * no decade filter and no per-request genre+decade cross filter, so this
	 * returns a popularity-ranked pool for the requested artist or genre
	 * *without* decade precision — callers needing decade precision should
	 * hydrate candidates via `getTrack` and filter locally, or prefer
	 * `track_cache` (already `(genre, decade)`-indexed, §8.3), which is what
	 * the interactive distractor path (`distractors.ts`) does and is the whole
	 * reason that cache exists.
	 */
	async poolForFilters(f: GenerationFilters): Promise<CatalogTrack[]> {
		const limit = Math.max(f.rounds * 3, 30);

		if (f.seed) {
			const artist = await this.resolveArtistByName(f.seed);
			if (!artist) return [];
			const body = await this.getJson<{ data: DeezerTrackSummary[] }>(
				buildUrl(`/artist/${artist.id}/top`, { limit })
			);
			return (body?.data ?? []).map(summaryToCatalogTrack);
		}

		if (f.genre) {
			const genreId = await this.resolveGenreId(f.genre);
			if (genreId === null) return [];
			const body = await this.getJson<DeezerChartTracksResponse>(
				buildUrl(`/chart/${genreId}/tracks`, { limit })
			);
			return (body?.data ?? []).map(summaryToCatalogTrack);
		}

		// No filter at all: the overall chart is the least-bad generic pool.
		const body = await this.getJson<DeezerChartTracksResponse>(
			buildUrl('/chart/0/tracks', { limit })
		);
		return (body?.data ?? []).map(summaryToCatalogTrack);
	}

	// -------------------------------------------------------------------------
	// Extras beyond the interface — reused by assembly.ts and seed-cache.ts
	// -------------------------------------------------------------------------

	/**
	 * Resolves an (artist, title) pair the way the Phase 0 probe does
	 * (`scripts/catalog-probe.ts`): a strict `artist:"X" track:"Y"` query
	 * first, falling back to a plain query when the strict form finds nothing.
	 * Quoted-field search is precise but occasionally too strict for looser
	 * transliterations; the plain fallback recovers those.
	 */
	async findTrackByArtistAndTitle(
		artist: string,
		title: string
	): Promise<DeezerTrackSummary | null> {
		const strictQuery = `artist:"${artist}" track:"${title}"`;
		const strict = await this.getJson<DeezerSearchTrackResponse>(
			buildUrl('/search/track', { q: strictQuery })
		);
		if (strict?.data.length) return strict.data[0];

		const plain = await this.getJson<DeezerSearchTrackResponse>(
			buildUrl('/search/track', { q: `${artist} ${title}` })
		);
		return plain?.data[0] ?? null;
	}

	/**
	 * Artist search ranked by **popularity, not search order** (plan §G-16 — a
	 * real bug the Phase 0 probe found: a naive "first exact-name match" picks
	 * an obscure homonym for some queries; e.g. searching "Air" without this
	 * fix could return a tribute act with a handful of fans over the actual
	 * Air with hundreds of thousands). Among candidates whose normalized name
	 * exactly matches the query, the one with the highest `nb_fan` wins; if
	 * none match exactly, falls back to Deezer's own top search result.
	 */
	async resolveArtistByName(name: string): Promise<DeezerArtistSearchResult | null> {
		const body = await this.getJson<DeezerSearchArtistResponse>(
			buildUrl('/search/artist', { q: name })
		);
		const candidates = body?.data ?? [];
		if (candidates.length === 0) return null;

		const target = simpleFold(name);
		const exact = candidates.filter((c) => simpleFold(c.name) === target);
		if (exact.length === 0) return candidates[0];

		return exact.reduce((best, c) => ((c.nb_fan ?? 0) > (best.nb_fan ?? 0) ? c : best));
	}

	/** Resolves a genre name (case/diacritic-insensitive, substring-tolerant) to a Deezer genre id via `/genre`. */
	async resolveGenreId(genreName: string): Promise<number | null> {
		const body = await this.getJson<DeezerGenreListResponse>(buildUrl('/genre'));
		const target = simpleFold(genreName);
		const genres = body?.data ?? [];

		const exact = genres.find((g) => simpleFold(g.name) === target);
		if (exact) return exact.id;

		const partial = genres.find(
			(g) => simpleFold(g.name).includes(target) || target.includes(simpleFold(g.name))
		);
		return partial?.id ?? null;
	}

	// -------------------------------------------------------------------------
	// HTTP plumbing
	// -------------------------------------------------------------------------

	private async fetchRaw(url: string): Promise<Response> {
		return this.throttle.run(() => this.fetchImpl(url));
	}

	/** GET + JSON parse + Deezer's 200-with-`{error}` quirk, no caching. */
	private async getJson<T>(url: string): Promise<T | null> {
		const res = await this.fetchRaw(url);
		if (!res.ok) return null;
		const body: unknown = await res.json().catch(() => null);
		if (body === null || isErrorBody(body)) return null;
		return body as T;
	}

	/** Same as `getJson`, but served through the §5.3 24 h Workers Cache API when a cache was supplied. */
	private async getJsonCached<T>(url: string): Promise<T | null> {
		if (!this.cache) return this.getJson<T>(url);

		const cacheKey = new Request(url);
		const cached = await this.cache.match(cacheKey);
		if (cached) {
			const body: unknown = await cached.json().catch(() => null);
			if (body !== null && !isErrorBody(body)) return body as T;
		}

		const res = await this.fetchRaw(url);
		if (!res.ok) return null;
		const body: unknown = await res.json().catch(() => null);
		if (body === null || isErrorBody(body)) return null;

		const toStore = new Response(JSON.stringify(body), {
			headers: {
				'content-type': 'application/json',
				'cache-control': `max-age=${SEARCH_CACHE_TTL_SECONDS}`
			}
		});
		await this.cache.put(cacheKey, toStore).catch(() => undefined);

		return body as T;
	}
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function buildUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
	const url = new URL(DEEZER_BASE + path);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	return url.toString();
}

/** Cheap ASCII/diacritic fold for genre/artist name comparisons — not the full §8.1 pipeline (no punctuation/article rules needed here). */
function simpleFold(input: string): string {
	return input.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** Search/chart/top results: lightweight, genre + releaseYear intentionally null (§5.2 — hydration is a second call). */
function summaryToCatalogTrack(track: DeezerTrackSummary): CatalogTrack {
	return {
		providerId: namespacedId(PROVIDER_NAME, track.id),
		title: track.title,
		titleShort: track.title_short,
		artists: [{ name: track.artist.name, primary: true }],
		albumTitle: track.album?.title ?? '',
		coverUrl: track.album?.cover_medium ?? null,
		releaseYear: null,
		genre: null
	};
}

/** `/track/{id}` + `/album/{id}` hydration → the fully-populated CatalogTrack quiz assembly needs. */
function fullTrackToCatalogTrack(
	track: DeezerTrackFull,
	album: DeezerAlbumFull | null
): CatalogTrack {
	const artists = contributorsToArtists(track);
	const releaseDate = album?.release_date ?? track.release_date ?? null;
	const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : null;
	const genre = album?.genres?.data?.[0]?.name ?? null;

	return {
		providerId: namespacedId(PROVIDER_NAME, track.id),
		title: track.title,
		titleShort: track.title_short,
		artists,
		albumTitle: album?.title ?? track.album?.title ?? '',
		coverUrl: album?.cover_medium ?? track.album?.cover_medium ?? null,
		releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
		genre
	};
}

/** ANS-3: every credited artist is accepted, with the first credited artist flagged primary. */
function contributorsToArtists(track: DeezerTrackFull): CreditedArtist[] {
	if (track.contributors && track.contributors.length > 0) {
		return track.contributors.map((c, i) => ({ name: c.name, primary: i === 0 }));
	}
	return [{ name: track.artist.name, primary: true }];
}
