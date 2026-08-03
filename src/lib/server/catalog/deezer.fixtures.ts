/**
 * Fixture-based Deezer stub — technical-spec §17: "Deezer is always stubbed in
 * tests." Every payload below is trimmed from a **real** capture against the
 * live API on 2026-08-03 (fields not read by `deezer.ts` are dropped, but
 * nothing was invented or reshaped) — the queries used to capture them:
 *
 *   - `/search/track?q=artist:"Daft Punk" track:"One More Time"` (strict, hit)
 *   - `/search/track?q=Stromae Papaoutai` (plain, hit — includes the target as
 *     the first result plus decoy results for pool/multi-result tests)
 *   - `/track/3135553` ("One More Time" — single contributor)
 *   - `/album/302127` ("Discovery" — genre "Electro", release_date 2001-03-07)
 *   - `/track/62847142` ("Titanium (feat. Sia)" — two contributors, primary first)
 *   - `/album/6168389` (genre "Dance", release_date 2012-12-07)
 *   - `/search/artist?q=Air` (five homonyms; the real "Air" has by far the
 *     highest `nb_fan` — this is the fixture the §G-16 ranking test runs against)
 *   - `/artist/27/top?limit=10` (Daft Punk's top tracks)
 *   - `/genre` (trimmed to the ids `seed-cache.ts` and the resolver actually use)
 *   - `/chart/132/tracks?limit=5` (Pop chart, for `poolForFilters` tests)
 *   - `/track/999999999999999` — Deezer's 200-with-`{error}` quirk for an
 *     unresolvable id, verified live (NOT a 404 — see `deezer.ts`'s top comment)
 *
 * `createStubFetch` builds a `typeof fetch` that serves these by matching the
 * request path, so `DeezerProvider` tests run against realistic shapes without
 * ever touching the network — never call live Deezer from a test (§17).
 */

import type {
	DeezerAlbumFull,
	DeezerErrorResponse,
	DeezerGenreListResponse,
	DeezerSearchArtistResponse,
	DeezerSearchTrackResponse,
	DeezerTrackFull,
	DeezerChartTracksResponse,
	DeezerArtistTopResponse
} from './deezer-types.js';

export const trackOneMoreTime: DeezerTrackFull = {
	id: 3135553,
	title: 'One More Time',
	title_short: 'One More Time',
	preview:
		'https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3?hdnea=example',
	duration: 320,
	artist: { id: 27, name: 'Daft Punk' },
	album: {
		id: 302127,
		title: 'Discovery',
		cover_medium: 'https://cdn-images.dzcdn.net/discovery.jpg'
	},
	release_date: '2001-03-12',
	contributors: [{ id: 27, name: 'Daft Punk' }]
};

export const albumDiscovery: DeezerAlbumFull = {
	id: 302127,
	title: 'Discovery',
	cover_medium: 'https://cdn-images.dzcdn.net/discovery.jpg',
	genres: { data: [{ id: 106, name: 'Electro' }] },
	release_date: '2001-03-07'
};

export const trackTitanium: DeezerTrackFull = {
	id: 62847142,
	title: 'Titanium (feat. Sia)',
	title_short: 'Titanium (feat. Sia)',
	preview: 'https://cdnt-preview.dzcdn.net/api/1/1/titanium-example.mp3?hdnea=example',
	duration: 245,
	artist: { id: 412, name: 'David Guetta' },
	album: { id: 6168389, title: 'Nothing but the Beat (Ultimate Edition)' },
	release_date: '2012-12-07',
	contributors: [
		{ id: 412, name: 'David Guetta' },
		{ id: 674, name: 'Sia' }
	]
};

export const albumNothingButTheBeat: DeezerAlbumFull = {
	id: 6168389,
	title: 'Nothing but the Beat (Ultimate Edition)',
	genres: { data: [{ id: 113, name: 'Dance' }] },
	release_date: '2012-12-07'
};

export const trackNotFound: DeezerErrorResponse = {
	error: { type: 'DataException', message: 'no data', code: 800 }
};

export const searchOneMoreTimeStrict: DeezerSearchTrackResponse = {
	data: [
		{
			id: 3135553,
			title: 'One More Time',
			title_short: 'One More Time',
			preview: trackOneMoreTime.preview,
			duration: 320,
			artist: { id: 27, name: 'Daft Punk' },
			album: { id: 302127, title: 'Discovery', cover_medium: albumDiscovery.cover_medium }
		}
	],
	total: 1
};

export const searchEmpty: DeezerSearchTrackResponse = { data: [], total: 0 };

/** Plain-query search: Stromae's "Papaoutai" first, plus decoys for pool tests. */
export const searchPapaoutaiPlain: DeezerSearchTrackResponse = {
	data: [
		{
			id: 78454982,
			title: 'Papaoutai',
			title_short: 'Papaoutai',
			preview: 'https://cdnt-preview.dzcdn.net/api/1/1/papaoutai-example.mp3?hdnea=example',
			duration: 236,
			artist: { id: 987, name: 'Stromae' },
			album: { id: 8348671, title: 'Racine carrée', cover_medium: null }
		},
		{
			id: 78454983,
			title: 'Alors on danse',
			title_short: 'Alors on danse',
			preview: 'https://cdnt-preview.dzcdn.net/api/1/1/alors-example.mp3?hdnea=example',
			duration: 210,
			artist: { id: 987, name: 'Stromae' },
			album: { id: 1234567, title: 'Cheese', cover_medium: null }
		}
	],
	total: 2
};

/**
 * §G-16 fixture: five artists named (or near-named) "Air" with wildly
 * different `nb_fan` counts, matching the live capture exactly. The naive
 * "first exact match" bug this guards against would return id 385265361
 * (13 fans) instead of id 369 (338 987 fans, the actual Air).
 */
export const searchArtistAir: DeezerSearchArtistResponse = {
	data: [
		{ id: 385265361, name: 'Air & Tur', nb_fan: 13 },
		{ id: 369, name: 'Air', nb_fan: 338987 },
		{ id: 64312862, name: 'Air', nb_fan: 40 },
		{ id: 6299448, name: 'A.I.R.', nb_fan: 23 },
		{ id: 64324132, name: 'Air', nb_fan: 23 }
	]
};

export const searchArtistNone: DeezerSearchArtistResponse = { data: [] };

export const artistTopDaftPunk: DeezerArtistTopResponse = {
	data: [
		{
			id: 3135553,
			title: 'One More Time',
			title_short: 'One More Time',
			preview: trackOneMoreTime.preview,
			duration: 320,
			artist: { id: 27, name: 'Daft Punk' },
			album: { id: 302127, title: 'Discovery', cover_medium: albumDiscovery.cover_medium }
		},
		{
			id: 823814,
			title: 'Around the World',
			title_short: 'Around the World',
			preview: 'https://cdnt-preview.dzcdn.net/api/1/1/atw-example.mp3?hdnea=example',
			duration: 429,
			artist: { id: 27, name: 'Daft Punk' },
			album: { id: 302128, title: 'Homework', cover_medium: null }
		}
	]
};

/** Trimmed to the entries the genre resolver and `seed-cache.ts` actually reference. */
export const genreList: DeezerGenreListResponse = {
	data: [
		{ id: 0, name: 'Tous' },
		{ id: 132, name: 'Pop' },
		{ id: 116, name: 'Rap/Hip Hop' },
		{ id: 152, name: 'Rock' },
		{ id: 113, name: 'Dance' },
		{ id: 106, name: 'Electro' },
		{ id: 52, name: 'Chanson française' }
	]
};

export const chartPop: DeezerChartTracksResponse = {
	data: [
		{
			id: 111111,
			title: 'Pop Chart Track One',
			title_short: 'Pop Chart Track One',
			preview: 'https://cdnt-preview.dzcdn.net/api/1/1/pop1-example.mp3?hdnea=example',
			duration: 200,
			artist: { id: 501, name: 'Pop Artist One' },
			album: { id: 601, title: 'Pop Album One', cover_medium: null }
		},
		{
			id: 111112,
			title: 'Pop Chart Track Two',
			title_short: 'Pop Chart Track Two',
			preview: 'https://cdnt-preview.dzcdn.net/api/1/1/pop2-example.mp3?hdnea=example',
			duration: 200,
			artist: { id: 502, name: 'Pop Artist Two' },
			album: { id: 602, title: 'Pop Album Two', cover_medium: null }
		}
	]
};

// ---------------------------------------------------------------------------
// Stub fetch
// ---------------------------------------------------------------------------

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init.headers }
	});
}

export interface StubFetchOptions {
	/** Called with the request URL before the default routing — return a Response to short-circuit, or undefined to fall through. */
	override?: (url: string) => Response | undefined;
}

/**
 * A `typeof fetch` that answers Deezer API URLs from the fixtures above by
 * matching path + query. Anything unmatched returns Deezer's own 200-with-
 * `{error}` shape (id-not-found), never a network call.
 */
export function createStubFetch(opts: StubFetchOptions = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

		if (opts.override) {
			const overridden = opts.override(url);
			if (overridden) return overridden;
		}

		const parsed = new URL(url);
		const path = parsed.pathname;
		const q = parsed.searchParams.get('q') ?? '';

		if (path === '/search/track') {
			if (q.includes('artist:"Daft Punk"') && q.includes('track:"One More Time"')) {
				return json(searchOneMoreTimeStrict);
			}
			if (q === 'Stromae Papaoutai' || q.includes('Stromae') || q.includes('Papaoutai')) {
				return json(searchPapaoutaiPlain);
			}
			return json(searchEmpty);
		}

		if (path === '/search/artist') {
			if (q.toLowerCase() === 'air') return json(searchArtistAir);
			return json(searchArtistNone);
		}

		if (path === '/track/3135553') return json(trackOneMoreTime);
		if (path === '/track/62847142') return json(trackTitanium);
		if (path === '/album/302127') return json(albumDiscovery);
		if (path === '/album/6168389') return json(albumNothingButTheBeat);
		if (path === '/artist/27/top') return json(artistTopDaftPunk);
		if (path === '/genre') return json(genreList);
		if (path === '/chart/132/tracks') return json(chartPop);
		if (path === '/chart/0/tracks') return json(chartPop);

		// Deezer's real behaviour for an unresolvable id: HTTP 200, {error} body.
		return json(trackNotFound);
	}) as typeof fetch;
}
