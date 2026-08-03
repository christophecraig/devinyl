/**
 * Raw Deezer REST response shapes — only the fields `deezer.ts` actually reads.
 * Captured against the live API on 2026-08-03 (see `deezer.fixtures.ts` for the
 * trimmed fixture payloads built from that capture).
 */

export interface DeezerArtistRef {
	id: number;
	name: string;
}

export interface DeezerAlbumRef {
	id: number;
	title?: string;
	cover_medium?: string | null;
}

/** A track as it appears inside `/search/track`, `/chart/{genre}/tracks`, `/artist/{id}/top`. */
export interface DeezerTrackSummary {
	id: number;
	title: string;
	title_short: string;
	preview: string;
	duration: number;
	artist: DeezerArtistRef;
	album: DeezerAlbumRef;
}

/** `/track/{id}` — adds `contributors` (every credited artist) and `release_date`. */
export interface DeezerTrackFull extends DeezerTrackSummary {
	release_date?: string;
	contributors?: DeezerArtistRef[];
}

export interface DeezerGenreRef {
	id: number;
	name: string;
}

/** `/album/{id}` — the second hydration call: search/track/chart omit genre + release date (§5.2). */
export interface DeezerAlbumFull {
	id: number;
	title: string;
	cover_medium?: string | null;
	genres?: { data: DeezerGenreRef[] };
	release_date?: string;
}

export interface DeezerSearchTrackResponse {
	data: DeezerTrackSummary[];
	total?: number;
}

export interface DeezerArtistSearchResult {
	id: number;
	name: string;
	/** Popularity — §G-16: ranking must use this, not raw search order. */
	nb_fan?: number;
}

export interface DeezerSearchArtistResponse {
	data: DeezerArtistSearchResult[];
}

export interface DeezerArtistTopResponse {
	data: DeezerTrackSummary[];
}

export interface DeezerChartTracksResponse {
	data: DeezerTrackSummary[];
}

export interface DeezerGenreListResponse {
	data: DeezerGenreRef[];
}

export interface DeezerErrorResponse {
	error: { type: string; message: string; code: number };
}
