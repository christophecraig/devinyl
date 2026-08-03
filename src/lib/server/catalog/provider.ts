/**
 * Catalog provider interface — technical-spec §5.1, adapted per plan §G-15.
 *
 * Deezer is the committed V1 provider, but every catalog access in the app goes
 * through this interface so a ToS change or shutdown (ADR-0001's central open
 * risk) is a bounded rewrite behind `deezer.ts`, not a redesign of the schema or
 * the callers.
 *
 * `CatalogTrack` lives in `src/lib/game/types.ts` (task 1.1) — it is not
 * redefined here. Implementations populate `CatalogTrack.providerId` with the
 * **namespaced** id (`namespacedId('deezer', 12345)` → `'deezer:12345'`), never
 * the bare provider id. `track_cache` and `quiz_track` key on that namespaced
 * form (plan §G-15): a provider swap re-resolves cached rows by (title, artist)
 * and re-namespaces them, instead of orphaning every quiz that references a bare
 * `deezer_id`.
 */

import type { CatalogTrack, GenerationFilters } from '$lib/game/types.js';

export interface CatalogProvider {
	/** Namespace prefix for this provider's ids, e.g. `'deezer'`. */
	readonly name: string;

	/** MUS-3 creation search. Results are lightweight: genre/releaseYear are `null` — see §5.2, hydration happens in `getTrack`. */
	searchTracks(q: string, opts?: { limit?: number }): Promise<CatalogTrack[]>;

	/**
	 * Full metadata for one track, accepting either a bare provider id
	 * (`'12345'`) or a namespaced id (`'deezer:12345'`) — callers holding a
	 * `track_cache.id` never need to unwrap it themselves. Internally this is
	 * the track+album hydration §5.2 describes: search omits genre and release
	 * date, so a second call resolves them. Returns `null` if the track no
	 * longer exists upstream (catalog churn).
	 */
	getTrack(providerTrackId: string): Promise<CatalogTrack | null>;

	/**
	 * A fresh, short-lived preview URL (§5.2 — these carry a signed, time-limited
	 * token and are never stored). Resolved again at every session start and at
	 * quiz-assembly availability checks; never cached beyond the single call site
	 * that needs it right now.
	 */
	getPreviewUrl(providerTrackId: string): Promise<string | null>;

	/**
	 * CREATE-5 auto-generation pool: a batch of candidate tracks matching the
	 * given filters, drawn live from the provider (charts / artist top / search).
	 * This is the *live* path — the interactive per-guess distractor path
	 * (`catalog/distractors.ts`, §8.3) draws from `track_cache` first and only
	 * calls this when a `(genre, decade)` bucket is too thin.
	 */
	poolForFilters(f: GenerationFilters): Promise<CatalogTrack[]>;
}

// ---------------------------------------------------------------------------
// Namespaced ids (plan §G-15)
// ---------------------------------------------------------------------------

/** Build the namespaced key `track_cache` and `quiz_track` reference: `deezer:12345`. */
export function namespacedId(provider: string, providerTrackId: string | number): string {
	return `${provider}:${providerTrackId}`;
}

export interface ParsedNamespacedId {
	provider: string;
	providerTrackId: string;
}

/**
 * Splits `'deezer:12345'` into its parts. Returns `null` for anything that
 * isn't a well-formed namespaced id (empty provider, empty id, no separator)
 * so callers can decide whether to treat a bare id as their own provider's.
 */
export function parseNamespacedId(id: string): ParsedNamespacedId | null {
	const sep = id.indexOf(':');
	if (sep <= 0 || sep === id.length - 1) return null;
	return { provider: id.slice(0, sep), providerTrackId: id.slice(sep + 1) };
}

/**
 * Resolves an id that may be bare (`'12345'`) or namespaced (`'deezer:12345'`)
 * into the bare id this provider's own API calls need. A namespaced id for a
 * *different* provider is a caller bug — surfaced as a thrown error rather than
 * silently querying the wrong catalog.
 */
export function resolveBareId(provider: string, id: string): string {
	const parsed = parseNamespacedId(id);
	if (parsed === null) return id; // bare id, assumed to belong to this provider
	if (parsed.provider !== provider) {
		throw new Error(`id ${id} is namespaced for provider "${parsed.provider}", not "${provider}"`);
	}
	return parsed.providerTrackId;
}
