#!/usr/bin/env -S npx tsx@latest
/**
 * scripts/itunes-probe.ts — iTunes Search API fallback-provider probe
 * (technical-spec.md §19 risk row: "iTunes Search API as documented fallback adapter")
 *
 * Standalone script. ZERO app dependencies — only Node builtins + fetch.
 * Mirrors scripts/catalog-probe.ts's structure and pass criteria so the two
 * providers are directly comparable. Uses the SAME scripts/probes.json corpus.
 *
 * Run with:
 *   npx -y tsx@4 scripts/itunes-probe.ts
 *
 * Verifies, against the LIVE iTunes Search API + CDN:
 *   1. Track probes: search (country=FR) -> expected track found (title + artist
 *      match via local normalization) -> preview URL returns 200/206 (ranged GET)
 *      -> primaryGenreName + releaseDate present INLINE on the search result
 *      (no second hydration call needed — unlike Deezer).
 *   2. Preview duration: exact duration via MP4 `mvhd` atom parsing on a ~20-track
 *      sample, plus byte-size-derived estimate for every previewed track.
 *   3. country=US spot-check on a subset, to see if coverage differs from FR.
 *   4. Artist probes: entity=musicArtist search, then lookup?id=&entity=song&limit=50
 *      (iTunes has no direct "top tracks" endpoint) — pool-feasibility data.
 *   5. Theme probes: same usable-ratio measurement as the Deezer probe.
 *   6. CORS: GET with Origin header + OPTIONS preflight on ~10 preview URLs.
 *   7. Format: content-type of preview responses.
 *
 * Output: scripts/.itunes-probe-results.json (full machine-readable dump).
 * Progress is printed to stderr as the run proceeds.
 *
 * Rate limiting: Apple's iTunes Search API is documented (informally — Apple does
 * not publish a hard number) at roughly 20 calls/minute, returning HTTP 403 when
 * throttled. This script serializes ALL calls to itunes.apple.com (search + lookup)
 * with ~3.5s spacing and exponential backoff + retry on 403. Preview-CDN requests
 * (a different host) are throttled more loosely since they are not the rate-limited
 * "Search API" surface.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = path.join(__dirname, 'probes.json');
const RESULTS_PATH = path.join(__dirname, '.itunes-probe-results.json');

// ---------------------------------------------------------------------------
// Local normalizer — deliberately NOT imported from src/. Mirrors the intent
// of the future src/lib/game/normalize.ts §8.1 pipeline, simplified for probe
// comparison purposes only (no article-stripping, no digit-folding).
// Same logic as scripts/catalog-probe.ts's normalizer, kept in lockstep.
// ---------------------------------------------------------------------------

function normalize(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '') // strip combining marks (accents)
		.replace(/ß/g, 'ss')
		.replace(/œ/gi, 'oe')
		.replace(/æ/gi, 'ae')
		.toLowerCase()
		.replace(/\([^)]*\)/g, ' ')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/\s-\s.*$/g, ' ')
		.replace(/\b(feat\.?|ft\.?|featuring|avec)\b.*$/gi, ' ')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Serialized throttle for itunes.apple.com (search + lookup) — ~20 req/min
// documented ceiling. One request in flight at a time, ~3.5s between starts,
// exponential backoff + retry on 403.
// ---------------------------------------------------------------------------

const ITUNES_MIN_SPACING_MS = 3500;
let lastItunesCallAt = 0;
let itunesCallCount = 0;
let itunes403Count = 0;
let itunesQueue: Promise<unknown> = Promise.resolve();

async function itunesFetch(url: string, maxRetries = 4): Promise<Response> {
	// Serialize: chain onto the queue so only one iTunes API call is in flight,
	// spaced at least ITUNES_MIN_SPACING_MS apart.
	const run = itunesQueue.then(async () => {
		const wait = Math.max(0, lastItunesCallAt + ITUNES_MIN_SPACING_MS - Date.now());
		if (wait > 0) await sleep(wait);
		lastItunesCallAt = Date.now();
	});
	itunesQueue = run.catch(() => {});
	await run;

	let attempt = 0;
	for (;;) {
		itunesCallCount++;
		let res: Response;
		try {
			res = await fetch(url, { headers: { 'User-Agent': 'devinyl-itunes-probe/1.0' } });
		} catch (err) {
			if (attempt >= maxRetries) throw err;
			const backoff = 2000 * 2 ** attempt;
			process.stderr.write(
				`  [network error, retry ${attempt + 1}] ${(err as Error).message} — backing off ${backoff}ms\n`
			);
			await sleep(backoff);
			attempt++;
			continue;
		}
		if (res.status === 403) {
			itunes403Count++;
			if (attempt >= maxRetries) {
				process.stderr.write(`  [403] giving up after ${attempt + 1} attempts on ${url}\n`);
				return res;
			}
			const backoff = 3000 * 2 ** attempt; // 3s, 6s, 12s, 24s
			process.stderr.write(
				`  [403 throttled, retry ${attempt + 1}] backing off ${backoff}ms — ${url}\n`
			);
			await sleep(backoff);
			attempt++;
			continue;
		}
		if (res.status === 429 || res.status >= 500) {
			if (attempt < maxRetries) {
				const backoff = 1500 * (attempt + 1);
				process.stderr.write(
					`  [${res.status}, retry ${attempt + 1}] backing off ${backoff}ms — ${url}\n`
				);
				await sleep(backoff);
				attempt++;
				continue;
			}
		}
		return res;
	}
}

// Looser throttle for the preview CDN (audio files) — not the documented
// rate-limited surface, but still be a reasonable citizen: cap concurrency.
class ConcurrencyLimiter {
	private inFlight = 0;
	constructor(private max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		while (this.inFlight >= this.max) await sleep(50);
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
		}
	}
}
const cdnLimiter = new ConcurrencyLimiter(5);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackProbe {
	artist: string;
	expectedTrack: string;
	genre: string;
	era: 'classic' | 'current';
}

interface ProbesFile {
	trackProbes: TrackProbe[];
	artistProbes: string[];
	themeProbes: string[];
}

interface ITunesSearchResult {
	wrapperType?: string;
	kind?: string;
	trackId?: number;
	artistId?: number;
	artistName?: string;
	trackName?: string;
	trackCensoredName?: string;
	collectionName?: string;
	previewUrl?: string;
	artworkUrl100?: string;
	trackTimeMillis?: number;
	primaryGenreName?: string;
	releaseDate?: string;
}

interface ITunesSearchResponse {
	resultCount: number;
	results: ITunesSearchResult[];
}

const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';

async function searchTracks(
	term: string,
	opts: { country?: string; limit?: number } = {}
): Promise<ITunesSearchResult[]> {
	const params = new URLSearchParams({
		term,
		media: 'music',
		entity: 'song',
		limit: String(opts.limit ?? 10),
		country: opts.country ?? 'FR'
	});
	const url = `${ITUNES_SEARCH}?${params.toString()}`;
	const res = await itunesFetch(url);
	if (!res.ok) return [];
	const json = (await res.json().catch(() => null)) as ITunesSearchResponse | null;
	return json?.results ?? [];
}

async function searchArtist(term: string, country = 'FR'): Promise<ITunesSearchResult[]> {
	const params = new URLSearchParams({ term, entity: 'musicArtist', limit: '10', country });
	const url = `${ITUNES_SEARCH}?${params.toString()}`;
	const res = await itunesFetch(url);
	if (!res.ok) return [];
	const json = (await res.json().catch(() => null)) as ITunesSearchResponse | null;
	return json?.results ?? [];
}

async function lookupArtistSongs(
	artistId: number,
	country = 'FR',
	limit = 50
): Promise<ITunesSearchResult[]> {
	const params = new URLSearchParams({
		id: String(artistId),
		entity: 'song',
		limit: String(limit),
		country
	});
	const url = `${ITUNES_LOOKUP}?${params.toString()}`;
	const res = await itunesFetch(url);
	if (!res.ok) return [];
	const json = (await res.json().catch(() => null)) as ITunesSearchResponse | null;
	return (json?.results ?? []).filter((r) => r.wrapperType === 'track');
}

function candidateMatches(candidate: ITunesSearchResult, artist: string, track: string): boolean {
	const nExpectedTitle = normalize(track);
	const nExpectedArtist = normalize(artist);
	const nTitle = normalize(candidate.trackName ?? '');
	const nTitleCensored = normalize(candidate.trackCensoredName ?? '');
	const nArtist = normalize(candidate.artistName ?? '');

	const titleOk =
		nTitle === nExpectedTitle ||
		nTitleCensored === nExpectedTitle ||
		nTitle.includes(nExpectedTitle) ||
		nExpectedTitle.includes(nTitle) ||
		nExpectedTitle.includes(nTitleCensored);
	const artistOk =
		nArtist === nExpectedArtist ||
		nArtist.includes(nExpectedArtist) ||
		nExpectedArtist.includes(nArtist);

	return titleOk && artistOk;
}

// ---------------------------------------------------------------------------
// Preview checks
// ---------------------------------------------------------------------------

async function checkPreview(url: string): Promise<{
	ok: boolean;
	status: number;
	contentType: string | null;
	contentRange: string | null;
	contentLength: number | null;
}> {
	return cdnLimiter.run(async () => {
		try {
			const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
			const ok = res.status === 200 || res.status === 206;
			const contentType = res.headers.get('content-type');
			const contentRange = res.headers.get('content-range');
			const cl = res.headers.get('content-length');
			await res.arrayBuffer().catch(() => {});
			return {
				ok,
				status: res.status,
				contentType,
				contentRange,
				contentLength: cl ? Number(cl) : null
			};
		} catch {
			return { ok: false, status: 0, contentType: null, contentRange: null, contentLength: null };
		}
	});
}

// Full byte size from content-range (total resource length), for bitrate-derived
// duration estimate — AAC previews are typically ~128-256kbps; we report both the
// byte-derived estimate AND the exact mvhd-parsed duration for the sample so the
// report can show how close the estimate would have been (methodology note).
const AAC_ASSUMED_BITRATE_BYTES_PER_SEC = 128_000 / 8;

// ---------------------------------------------------------------------------
// MP4 (.m4a) `mvhd` atom parser — exact preview duration.
// Box format: [4 bytes size][4 bytes fourcc][payload...]. size==1 means a
// 64-bit "largesize" follows (8 bytes) before payload. size==0 means "to EOF"
// (won't happen inside a fetched prefix; treated as "stop").
// We need to descend into `moov` -> `mvhd` (mvhd is NOT necessarily the first
// child of moov — `moov` can start with other boxes before mvhd in some
// encoders, though mvhd first is the common case). We recursively scan only
// container boxes we know about (moov) and skip unknown boxes by their size.
// ---------------------------------------------------------------------------

interface MvhdResult {
	timescale: number;
	durationUnits: number;
	durationSec: number;
}

function parseMvhdFromBuffer(buf: Uint8Array): MvhdResult | null {
	function findBox(
		data: Uint8Array,
		offset: number,
		end: number,
		fourcc: string
	): { start: number; end: number; payloadStart: number } | null {
		let pos = offset;
		while (pos + 8 <= end) {
			const size32 = readU32(data, pos);
			const type = readFourCC(data, pos + 4);
			let boxSize = size32;
			let headerLen = 8;
			if (size32 === 1) {
				if (pos + 16 > end) return null;
				// 64-bit largesize — read as Number (fine for our small buffers)
				const hi = readU32(data, pos + 8);
				const lo = readU32(data, pos + 12);
				boxSize = hi * 2 ** 32 + lo;
				headerLen = 16;
			} else if (size32 === 0) {
				// extends to EOF of the (full, real) file — unknowable from a prefix
				boxSize = end - pos;
			}
			if (type === fourcc) {
				return { start: pos, end: Math.min(pos + boxSize, end), payloadStart: pos + headerLen };
			}
			if (boxSize <= 0) return null; // malformed / can't progress
			pos += boxSize;
		}
		return null;
	}

	function readU32(data: Uint8Array, off: number): number {
		return ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
	}
	function readFourCC(data: Uint8Array, off: number): string {
		return String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
	}

	const moov = findBox(buf, 0, buf.length, 'moov');
	if (!moov) return null;
	const mvhd = findBox(buf, moov.payloadStart, moov.end, 'mvhd');
	if (!mvhd) return null;

	const p = mvhd.payloadStart;
	if (p + 4 > buf.length) return null;
	const version = buf[p];
	let timescale: number;
	let duration: number;
	if (version === 1) {
		// version(1) flags(3) creation(8) modification(8) timescale(4) duration(8)
		const base = p + 4 + 8 + 8;
		if (base + 12 > buf.length) return null;
		timescale = readU32(buf, base);
		const hi = readU32(buf, base + 4);
		const lo = readU32(buf, base + 8);
		duration = hi * 2 ** 32 + lo;
	} else {
		// version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
		const base = p + 4 + 4 + 4;
		if (base + 8 > buf.length) return null;
		timescale = readU32(buf, base);
		duration = readU32(buf, base + 4);
	}
	if (!timescale) return null;
	return { timescale, durationUnits: duration, durationSec: duration / timescale };
}

async function measureExactDuration(
	previewUrl: string
): Promise<{ mvhd: MvhdResult | null; bytesFetched: number; error?: string }> {
	return cdnLimiter.run(async () => {
		// Fetch a generous prefix — moov is usually at the front for streamable
		// previews ("faststart"), but not guaranteed, so we try progressively
		// larger prefixes before giving up.
		const sizes = [64 * 1024, 512 * 1024, 2 * 1024 * 1024];
		for (const size of sizes) {
			try {
				const res = await fetch(previewUrl, { headers: { Range: `bytes=0-${size - 1}` } });
				if (!(res.status === 200 || res.status === 206)) {
					return { mvhd: null, bytesFetched: 0, error: `http ${res.status}` };
				}
				const buf = new Uint8Array(await res.arrayBuffer());
				const mvhd = parseMvhdFromBuffer(buf);
				if (mvhd) return { mvhd, bytesFetched: buf.length };
				if (buf.length < size) {
					// server returned less than requested — no more data to try
					return { mvhd: null, bytesFetched: buf.length, error: 'mvhd_not_found_in_full_resource' };
				}
				// else: try a bigger prefix
			} catch (err) {
				return {
					mvhd: null,
					bytesFetched: 0,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
		return { mvhd: null, bytesFetched: 0, error: 'mvhd_not_found_after_2mb' };
	});
}

// ---------------------------------------------------------------------------
// CORS probe
// ---------------------------------------------------------------------------

function headersToObject(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	h.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

interface CorsResult {
	trackId: number;
	previewUrl: string;
	getStatus?: number;
	getHeaders?: Record<string, string>;
	optionsStatus?: number;
	optionsHeaders?: Record<string, string>;
	error?: string;
}

const PROBE_ORIGIN = 'https://devinyl.workers.dev';

async function runCorsProbe(
	trackId: number,
	previewUrl: string,
	index: number,
	total: number
): Promise<CorsResult> {
	process.stderr.write(`[cors ${index + 1}/${total}] track ${trackId}\n`);
	const result: CorsResult = { trackId, previewUrl };
	try {
		const getRes = await cdnLimiter.run(() =>
			fetch(previewUrl, { method: 'GET', headers: { Origin: PROBE_ORIGIN, Range: 'bytes=0-1' } })
		);
		result.getStatus = getRes.status;
		result.getHeaders = headersToObject(getRes.headers);
		await getRes.arrayBuffer().catch(() => {});

		const optRes = await cdnLimiter.run(() =>
			fetch(previewUrl, {
				method: 'OPTIONS',
				headers: { Origin: PROBE_ORIGIN, 'Access-Control-Request-Method': 'GET' }
			})
		);
		result.optionsStatus = optRes.status;
		result.optionsHeaders = headersToObject(optRes.headers);
		await optRes.arrayBuffer().catch(() => {});
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Track probe runner
// ---------------------------------------------------------------------------

interface TrackProbeResult {
	artist: string;
	expectedTrack: string;
	genre: string;
	era: string;
	found: boolean;
	matchedTrackName?: string;
	matchedArtistName?: string;
	searchStrategy?: 'combined' | 'title-only';
	trackId?: number;
	collectionName?: string;
	artworkUrl100?: string;
	trackTimeMillis?: number;
	previewUrl?: string;
	previewOk?: boolean;
	previewStatus?: number;
	previewContentType?: string | null;
	primaryGenreName?: string | null;
	releaseDate?: string | null;
	metadataOk?: boolean; // primaryGenreName present AND releaseDate present, inline
	pass: boolean; // found AND previewOk AND metadataOk
	failureReason?: string;
	error?: string;
}

async function runTrackProbe(
	probe: TrackProbe,
	index: number,
	total: number
): Promise<TrackProbeResult> {
	process.stderr.write(`[track ${index + 1}/${total}] ${probe.artist} — ${probe.expectedTrack}\n`);
	const result: TrackProbeResult = {
		artist: probe.artist,
		expectedTrack: probe.expectedTrack,
		genre: probe.genre,
		era: probe.era,
		found: false,
		pass: false
	};
	try {
		let candidates = await searchTracks(`${probe.artist} ${probe.expectedTrack}`, {
			country: 'FR',
			limit: 15
		});
		let strategy: 'combined' | 'title-only' = 'combined';
		let match = candidates.find((c) => candidateMatches(c, probe.artist, probe.expectedTrack));
		if (!match) {
			candidates = await searchTracks(probe.expectedTrack, { country: 'FR', limit: 20 });
			strategy = 'title-only';
			match = candidates.find((c) => candidateMatches(c, probe.artist, probe.expectedTrack));
		}
		if (!match) {
			result.failureReason = 'not_found';
			return result;
		}

		result.found = true;
		result.matchedTrackName = match.trackName;
		result.matchedArtistName = match.artistName;
		result.searchStrategy = strategy;
		result.trackId = match.trackId;
		result.collectionName = match.collectionName;
		result.artworkUrl100 = match.artworkUrl100;
		result.trackTimeMillis = match.trackTimeMillis;
		result.primaryGenreName = match.primaryGenreName ?? null;
		result.releaseDate = match.releaseDate ?? null;
		result.metadataOk = !!match.primaryGenreName && !!match.releaseDate;
		if (!result.metadataOk) result.failureReason = 'missing_genre_or_release_date';

		if (!match.previewUrl) {
			result.previewOk = false;
			if (!result.failureReason) result.failureReason = 'no_preview_url';
		} else {
			result.previewUrl = match.previewUrl;
			const check = await checkPreview(match.previewUrl);
			result.previewOk = check.ok;
			result.previewStatus = check.status;
			result.previewContentType = check.contentType;
			if (!check.ok && !result.failureReason) result.failureReason = `preview_http_${check.status}`;
		}

		result.pass = result.found && !!result.previewOk && !!result.metadataOk;
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		result.failureReason = 'exception';
		return result;
	}
}

// ---------------------------------------------------------------------------
// country=US spot-check
// ---------------------------------------------------------------------------

interface CountryCompareResult {
	artist: string;
	expectedTrack: string;
	foundFR: boolean;
	foundUS: boolean;
	hasPreviewFR: boolean;
	hasPreviewUS: boolean;
}

async function runCountryCompare(
	probe: TrackProbe,
	frResult: TrackProbeResult,
	index: number,
	total: number
): Promise<CountryCompareResult> {
	process.stderr.write(
		`[us-compare ${index + 1}/${total}] ${probe.artist} — ${probe.expectedTrack}\n`
	);
	const candidatesUS = await searchTracks(`${probe.artist} ${probe.expectedTrack}`, {
		country: 'US',
		limit: 15
	});
	const matchUS = candidatesUS.find((c) => candidateMatches(c, probe.artist, probe.expectedTrack));
	return {
		artist: probe.artist,
		expectedTrack: probe.expectedTrack,
		foundFR: frResult.found,
		foundUS: !!matchUS,
		hasPreviewFR: !!frResult.previewUrl,
		hasPreviewUS: !!matchUS?.previewUrl
	};
}

// ---------------------------------------------------------------------------
// Artist probe runner (pool-feasibility, item C)
// ---------------------------------------------------------------------------

interface ArtistProbeResult {
	query: string;
	found: boolean;
	matchedName?: string;
	artistId?: number;
	songCount?: number;
	songsWithPreview?: number;
	distinctGenres?: string[];
	pass: boolean;
	error?: string;
}

async function runArtistProbe(
	query: string,
	index: number,
	total: number
): Promise<ArtistProbeResult> {
	process.stderr.write(`[artist ${index + 1}/${total}] ${query}\n`);
	const result: ArtistProbeResult = { query, found: false, pass: false };
	try {
		const artists = await searchArtist(query, 'FR');
		const nq = normalize(query);
		const exact = artists.find((a) => normalize(a.artistName ?? '') === nq);
		const match = exact ?? artists[0];
		if (!match?.artistId) {
			result.error = 'artist_not_found';
			return result;
		}
		result.found = true;
		result.matchedName = match.artistName;
		result.artistId = match.artistId;

		const songs = await lookupArtistSongs(match.artistId, 'FR', 50);
		result.songCount = songs.length;
		result.songsWithPreview = songs.filter((s) => !!s.previewUrl).length;
		result.distinctGenres = [
			...new Set(songs.map((s) => s.primaryGenreName).filter(Boolean))
		] as string[];
		result.pass = result.songCount >= 10;
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Theme probe runner (item D)
// ---------------------------------------------------------------------------

const FRENCH_SIGNAL_ARTISTS = new Set(
	[
		'stromae',
		'indila',
		'angele',
		'clara luciani',
		'julien dore',
		'christine and the queens',
		'zaz',
		'louane',
		'vianney',
		'pomme',
		'juliette armanet',
		'iam',
		'ntm',
		'mc solaar',
		'orelsan',
		'pnl',
		'nekfeu',
		'damso',
		'jul',
		'aya nakamura',
		'gims',
		'soprano',
		'booba',
		'bigflo & oli',
		'lomepal',
		'sch',
		'ninho',
		'edith piaf',
		'jacques brel',
		'georges brassens',
		'barbara',
		'charles aznavour',
		'serge gainsbourg',
		'jean-jacques goldman',
		'francis cabrel',
		'daniel balavoine',
		'michel sardou',
		'renaud',
		'alain souchon',
		'alain bashung',
		'france gall',
		'mylene farmer',
		'indochine',
		'telephone',
		'noir desir',
		'etienne daho',
		'vanessa paradis',
		'patricia kaas',
		'patrick bruel',
		'florent pagny',
		'zazie',
		'pascal obispo',
		'manau',
		"diam's",
		'daft punk',
		'air',
		'justice',
		'gesaffelstein',
		'david guetta',
		'kendji girac',
		'amir',
		'slimane',
		'm pokora',
		'superbus',
		'yannick noah',
		'grand corps malade',
		'chimene badi',
		'christophe mae'
	].map((s) => normalize(s))
);

function looksFrenchPlausible(track: ITunesSearchResult): boolean {
	const artistName = normalize(track.artistName ?? '');
	if (FRENCH_SIGNAL_ARTISTS.has(artistName)) return true;
	const raw = `${track.trackName ?? ''} ${track.artistName ?? ''}`;
	if (/[àâäéèêëïîôöùûüçœæ]/i.test(raw)) return true;
	const nTitle = normalize(track.trackName ?? '');
	const frenchWords = [
		' le ',
		' la ',
		' les ',
		' des ',
		' une ',
		' un ',
		' et ',
		' est ',
		' je ',
		' tu ',
		' nous ',
		' vous ',
		' avec ',
		' pour ',
		' dans ',
		' sur ',
		' amour ',
		' coeur '
	];
	const padded = ` ${nTitle} `;
	return frenchWords.some((w) => padded.includes(w));
}

interface ThemeProbeResult {
	query: string;
	sampledCount: number;
	frenchPlausibleCount: number;
	workingPreviewCount: number;
	usableCount: number;
	usableRatio: string;
	error?: string;
}

async function runThemeProbe(
	query: string,
	index: number,
	total: number
): Promise<ThemeProbeResult> {
	process.stderr.write(`[theme ${index + 1}/${total}] "${query}"\n`);
	const result: ThemeProbeResult = {
		query,
		sampledCount: 0,
		frenchPlausibleCount: 0,
		workingPreviewCount: 0,
		usableCount: 0,
		usableRatio: '0/25'
	};
	try {
		const tracks = await searchTracks(query, { country: 'FR', limit: 25 });
		result.sampledCount = tracks.length;
		const checks = await Promise.all(
			tracks.map(async (t) => {
				const frenchPlausible = looksFrenchPlausible(t);
				let previewOk = false;
				if (t.previewUrl) {
					const c = await checkPreview(t.previewUrl);
					previewOk = c.ok;
				}
				return { frenchPlausible, previewOk };
			})
		);
		result.frenchPlausibleCount = checks.filter((c) => c.frenchPlausible).length;
		result.workingPreviewCount = checks.filter((c) => c.previewOk).length;
		result.usableCount = checks.filter((c) => c.frenchPlausible && c.previewOk).length;
		result.usableRatio = `${result.usableCount}/${result.sampledCount}`;
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
	if (d === 0) return '0.0%';
	return `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
	const raw = await readFile(PROBES_PATH, 'utf-8');
	const probes = JSON.parse(raw) as ProbesFile;

	process.stderr.write(
		`Loaded ${probes.trackProbes.length} track probes, ${probes.artistProbes.length} artist probes, ${probes.themeProbes.length} theme probes\n`
	);
	process.stderr.write(
		`iTunes calls will be serialized at ~${ITUNES_MIN_SPACING_MS}ms spacing. Expect this run to take several minutes.\n\n`
	);

	// --- Track probes (sequential — throttle serializes anyway) ---
	process.stderr.write('=== Track probes (country=FR) ===\n');
	const trackResults: TrackProbeResult[] = [];
	for (let i = 0; i < probes.trackProbes.length; i++) {
		trackResults.push(await runTrackProbe(probes.trackProbes[i], i, probes.trackProbes.length));
	}

	// --- country=US spot-check on a stratified subset (~20) ---
	process.stderr.write('\n=== country=US spot-check (subset of 20) ===\n');
	const usSubsetIndices: number[] = [];
	for (
		let i = 0;
		i < trackResults.length && usSubsetIndices.length < 20;
		i += Math.max(1, Math.floor(trackResults.length / 20))
	) {
		usSubsetIndices.push(i);
	}
	const countryCompare: CountryCompareResult[] = [];
	for (let j = 0; j < usSubsetIndices.length; j++) {
		const idx = usSubsetIndices[j];
		countryCompare.push(
			await runCountryCompare(probes.trackProbes[idx], trackResults[idx], j, usSubsetIndices.length)
		);
	}

	// --- Artist probes ---
	process.stderr.write('\n=== Artist probes ===\n');
	const artistResults: ArtistProbeResult[] = [];
	for (let i = 0; i < probes.artistProbes.length; i++) {
		artistResults.push(await runArtistProbe(probes.artistProbes[i], i, probes.artistProbes.length));
	}

	// --- Theme probes ---
	process.stderr.write('\n=== Theme probes ===\n');
	const themeResults: ThemeProbeResult[] = [];
	for (let i = 0; i < probes.themeProbes.length; i++) {
		themeResults.push(await runThemeProbe(probes.themeProbes[i], i, probes.themeProbes.length));
	}

	// --- CORS probes: sample ~10 preview URLs from passing track probes ---
	process.stderr.write('\n=== CORS probes ===\n');
	const previewSample = trackResults
		.filter((r) => r.pass && r.trackId && r.previewUrl)
		.slice(0, 10);
	const corsResults: CorsResult[] = [];
	for (let i = 0; i < previewSample.length; i++) {
		const r = previewSample[i];
		corsResults.push(await runCorsProbe(r.trackId!, r.previewUrl!, i, previewSample.length));
	}

	// --- Exact duration via mvhd atom parsing, ~20-track sample ---
	process.stderr.write('\n=== Preview duration (mvhd atom parse), ~20-track sample ===\n');
	const durationSampleSource = trackResults.filter((r) => r.pass && r.previewUrl);
	const durationSample = durationSampleSource
		.filter((_, i) => i % Math.max(1, Math.floor(durationSampleSource.length / 20)) === 0)
		.slice(0, 20);
	interface DurationSampleResult {
		trackId: number;
		artist: string;
		expectedTrack: string;
		itunesTrackTimeMillis?: number;
		mvhdDurationSec: number | null;
		mvhdError?: string;
		byteEstimateDurationSec: number | null;
		bytesFetched: number;
	}
	const durationResults: DurationSampleResult[] = [];
	for (const r of durationSample) {
		process.stderr.write(`  measuring ${r.artist} — ${r.expectedTrack}...\n`);
		const measured = await measureExactDuration(r.previewUrl!);
		const preview = await checkPreview(r.previewUrl!);
		const byteEst = preview.contentRange
			? Number(preview.contentRange.split('/')[1]) / AAC_ASSUMED_BITRATE_BYTES_PER_SEC
			: null;
		durationResults.push({
			trackId: r.trackId!,
			artist: r.artist,
			expectedTrack: r.expectedTrack,
			itunesTrackTimeMillis: r.trackTimeMillis,
			mvhdDurationSec: measured.mvhd ? Math.round(measured.mvhd.durationSec * 100) / 100 : null,
			mvhdError: measured.error,
			byteEstimateDurationSec: byteEst ? Math.round(byteEst * 10) / 10 : null,
			bytesFetched: measured.bytesFetched
		});
	}

	// --- Summary ---
	const trackTotal = trackResults.length;
	const trackFoundCount = trackResults.filter((r) => r.found).length;
	const trackPreviewOkCount = trackResults.filter((r) => r.previewOk).length;
	const trackMetadataOkCount = trackResults.filter((r) => r.metadataOk).length;
	const trackCombinedPassCount = trackResults.filter((r) => r.pass).length;

	const artistTotal = artistResults.length;
	const artistPassCount = artistResults.filter((r) => r.pass).length;

	const corsAllOriginPresent = corsResults.filter(
		(r) => !!r.getHeaders?.['access-control-allow-origin']
	).length;

	const results = {
		runAt: new Date().toISOString(),
		itunesApiCallCount: itunesCallCount,
		itunes403Count: itunes403Count,
		trackProbes: trackResults,
		countryCompare,
		artistProbes: artistResults,
		themeProbes: themeResults,
		cors: corsResults,
		durationSample: durationResults,
		summary: {
			trackTotal,
			trackFoundCount,
			trackFoundRate: pct(trackFoundCount, trackTotal),
			trackPreviewOkCount,
			trackPreviewOkRate: pct(trackPreviewOkCount, trackTotal),
			trackMetadataOkCount,
			trackMetadataOkRate: pct(trackMetadataOkCount, trackTotal),
			trackCombinedPassCount,
			trackCombinedPassRate: pct(trackCombinedPassCount, trackTotal),
			artistTotal,
			artistPassCount,
			artistPassRate: pct(artistPassCount, artistTotal),
			corsAllOriginPresent,
			corsSampleSize: corsResults.length
		}
	};

	await writeFile(RESULTS_PATH, JSON.stringify(results, null, 2), 'utf-8');

	process.stderr.write('\n=== SUMMARY ===\n');
	process.stderr.write(`iTunes API calls made: ${itunesCallCount} (403s hit: ${itunes403Count})\n`);
	process.stderr.write(
		`Track: found ${trackFoundCount}/${trackTotal} (${results.summary.trackFoundRate}), preview OK ${trackPreviewOkCount}/${trackTotal} (${results.summary.trackPreviewOkRate}), metadata OK ${trackMetadataOkCount}/${trackTotal} (${results.summary.trackMetadataOkRate})\n`
	);
	process.stderr.write(
		`Track COMBINED pass: ${trackCombinedPassCount}/${trackTotal} (${results.summary.trackCombinedPassRate})\n`
	);
	process.stderr.write(
		`Artist pass: ${artistPassCount}/${artistTotal} (${results.summary.artistPassRate})\n`
	);
	process.stderr.write(
		`CORS: ${corsAllOriginPresent}/${corsResults.length} preview responses carried access-control-allow-origin\n`
	);
	process.stderr.write(`\nResults written to ${RESULTS_PATH}\n`);
}

main().catch((err) => {
	process.stderr.write(
		`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
	);
	process.exitCode = 1;
});
