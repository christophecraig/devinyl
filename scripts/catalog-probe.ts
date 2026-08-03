#!/usr/bin/env -S npx tsx@latest
/**
 * scripts/catalog-probe.ts — MUS-8 / Gate 0 go/no-go probe (technical-spec.md §5.5, §5.6 CORS)
 *
 * Standalone script. ZERO app dependencies — only Node builtins + fetch.
 * Run with:
 *   npx tsx@latest scripts/catalog-probe.ts
 * or
 *   node --experimental-strip-types scripts/catalog-probe.ts
 *
 * Verifies, against the LIVE Deezer API:
 *   1. Track probes: search -> expected track found (title + artist match via local
 *      normalization) -> preview URL returns 200/206 -> album hydration yields genre +
 *      release_date.
 *   2. Artist probes: search/artist finds a plausible hit; artist/{id}/top returns
 *      >=10 tracks with previews.
 *   3. Theme probes: search/track?q=<theme> — how many of the top 25 results look
 *      French-plausible and have a working preview.
 *   4. CORS: for a sample of preview URLs, issue a browser-like GET with an Origin
 *      header and an OPTIONS preflight; record the raw headers verbatim. This is the
 *      task 0.5 Gate-0 blocker check for the ArrayBuffer audio engine.
 *
 * Output: scripts/.probe-results.json (full machine-readable dump).
 * Progress is printed to stderr as the run proceeds.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = path.join(__dirname, 'probes.json');
const RESULTS_PATH = path.join(__dirname, '.probe-results.json');

// ---------------------------------------------------------------------------
// Local normalizer (deliberately NOT imported from src/ — this script must
// stand alone before any app code exists). Mirrors the intent of the future
// src/lib/game/normalize.ts §8.1 pipeline, simplified for probe comparison
// purposes only (no article-stripping, no digit-folding — not needed here).
// ---------------------------------------------------------------------------

function normalize(input: string): string {
	return (
		input
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '') // strip combining marks (accents)
			.replace(/ß/g, 'ss')
			.replace(/œ/gi, 'oe')
			.replace(/æ/gi, 'ae')
			.toLowerCase()
			// strip parenthetical / bracketed segments, e.g. "(Remastered 2011)", "[Live]"
			.replace(/\([^)]*\)/g, ' ')
			.replace(/\[[^\]]*\]/g, ' ')
			// strip trailing dash-suffixes, e.g. "- Radio Edit"
			.replace(/\s-\s.*$/g, ' ')
			// strip featuring segments
			.replace(/\b(feat\.?|ft\.?|featuring|avec)\b.*$/gi, ' ')
			// punctuation / apostrophes
			.replace(/[^\p{L}\p{N}\s]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

// ---------------------------------------------------------------------------
// Rate-limited request queue. Deezer allows 50 req / 5s per source IP.
// Target: max 8 concurrent, <40 req/5s, to stay safely under the limit.
// ---------------------------------------------------------------------------

const WINDOW_MS = 5000;
const MAX_REQ_PER_WINDOW = 38; // safety margin under 50
const MAX_CONCURRENT = 8;

class Throttle {
	private timestamps: number[] = [];
	private inFlight = 0;
	private queue: Array<() => void> = [];

	private async waitForSlot(): Promise<void> {
		for (;;) {
			const now = Date.now();
			this.timestamps = this.timestamps.filter((t) => now - t < WINDOW_MS);
			if (this.inFlight < MAX_CONCURRENT && this.timestamps.length < MAX_REQ_PER_WINDOW) {
				this.inFlight++;
				this.timestamps.push(now);
				return;
			}
			await sleep(60);
		}
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.waitForSlot();
		try {
			return await fn();
		} finally {
			this.inFlight--;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const throttle = new Throttle();

async function fetchWithRetry(url: string, init?: RequestInit, retries = 1): Promise<Response> {
	return throttle.run(async () => {
		let lastErr: unknown;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const res = await fetch(url, init);
				if (res.status === 429 || res.status >= 500) {
					if (attempt < retries) {
						const backoff = 500 * (attempt + 1);
						process.stderr.write(`  [retry] ${res.status} on ${url} — backing off ${backoff}ms\n`);
						await sleep(backoff);
						continue;
					}
				}
				return res;
			} catch (err) {
				lastErr = err;
				if (attempt < retries) {
					await sleep(500 * (attempt + 1));
					continue;
				}
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	});
}

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

interface DeezerArtist {
	id: number;
	name: string;
}

interface DeezerAlbum {
	id: number;
	title?: string;
}

interface DeezerTrack {
	id: number;
	title: string;
	title_short: string;
	preview: string;
	duration: number;
	artist: DeezerArtist;
	album: DeezerAlbum;
	contributors?: DeezerArtist[];
}

interface DeezerSearchResponse {
	data: DeezerTrack[];
	total?: number;
}

interface TrackProbeResult {
	artist: string;
	expectedTrack: string;
	genre: string;
	era: string;
	found: boolean;
	matchedTitle?: string;
	matchedArtist?: string;
	searchStrategy?: 'strict' | 'fallback';
	trackId?: number;
	previewOk?: boolean;
	previewStatus?: number;
	previewContentLength?: number | null;
	deezerDuration?: number;
	hydrationOk?: boolean;
	albumGenres?: string[] | null;
	albumReleaseDate?: string | null;
	pass: boolean; // found AND previewOk AND hydrationOk
	failureReason?: string;
	error?: string;
}

interface ArtistProbeResult {
	query: string;
	found: boolean;
	matchedName?: string;
	artistId?: number;
	topTrackCount?: number;
	topTracksWithPreview?: number;
	pass: boolean;
	error?: string;
}

interface ThemeProbeResult {
	query: string;
	totalResults: number;
	sampledCount: number;
	frenchPlausibleCount: number;
	workingPreviewCount: number;
	usableCount: number; // french-plausible AND has preview (sampled check on subset)
	usableRatio: string;
	error?: string;
}

interface CorsResult {
	trackId: number;
	previewUrl: string;
	getStatus?: number;
	getHeaders?: Record<string, string>;
	optionsStatus?: number;
	optionsHeaders?: Record<string, string>;
	fullResourceBytes?: number | null;
	estimatedDurationSec?: number | null;
	error?: string;
}

interface ProbeResults {
	runAt: string;
	trackProbes: TrackProbeResult[];
	artistProbes: ArtistProbeResult[];
	themeProbes: ThemeProbeResult[];
	cors: CorsResult[];
	durationSanity: Array<{
		trackId: number;
		contentLength: number | null;
		estimatedDurationSec: number | null;
		status: number;
	}>;
	summary: {
		trackTotal: number;
		trackFoundCount: number;
		trackFoundRate: string;
		trackPreviewOkCount: number;
		trackPreviewOkRate: string;
		trackHydrationOkCount: number;
		trackHydrationOkRate: string;
		trackCombinedPassCount: number;
		trackCombinedPassRate: string;
		artistTotal: number;
		artistPassCount: number;
		artistPassRate: string;
		corsAllOriginPresent: number;
		corsSampleSize: number;
	};
}

// ---------------------------------------------------------------------------
// Deezer helpers
// ---------------------------------------------------------------------------

const DEEZER_BASE = 'https://api.deezer.com';

async function searchTrackStrict(artist: string, track: string): Promise<DeezerTrack[]> {
	const q = `artist:"${artist}" track:"${track}"`;
	const url = `${DEEZER_BASE}/search/track?q=${encodeURIComponent(q)}`;
	const res = await fetchWithRetry(url);
	if (!res.ok) return [];
	const json = (await res.json()) as DeezerSearchResponse;
	return json.data ?? [];
}

async function searchTrackPlain(artist: string, track: string): Promise<DeezerTrack[]> {
	const q = `${artist} ${track}`;
	const url = `${DEEZER_BASE}/search/track?q=${encodeURIComponent(q)}`;
	const res = await fetchWithRetry(url);
	if (!res.ok) return [];
	const json = (await res.json()) as DeezerSearchResponse;
	return json.data ?? [];
}

function candidateMatches(candidate: DeezerTrack, artist: string, track: string): boolean {
	const nExpectedTitle = normalize(track);
	const nExpectedArtist = normalize(artist);
	const nTitle = normalize(candidate.title);
	const nTitleShort = normalize(candidate.title_short);
	const nArtist = normalize(candidate.artist?.name ?? '');
	const contributors = (candidate.contributors ?? []).map((c) => normalize(c.name));

	const titleOk =
		nTitle === nExpectedTitle ||
		nTitleShort === nExpectedTitle ||
		nTitle.includes(nExpectedTitle) ||
		nExpectedTitle.includes(nTitleShort);
	const artistOk =
		nArtist === nExpectedArtist ||
		contributors.includes(nExpectedArtist) ||
		nArtist.includes(nExpectedArtist) ||
		nExpectedArtist.includes(nArtist);

	return titleOk && artistOk;
}

async function getTrack(id: number): Promise<DeezerTrack | null> {
	const res = await fetchWithRetry(`${DEEZER_BASE}/track/${id}`);
	if (!res.ok) return null;
	return (await res.json()) as DeezerTrack;
}

interface DeezerAlbumFull {
	id: number;
	genres?: { data: Array<{ id: number; name: string }> };
	release_date?: string;
}

async function getAlbum(id: number): Promise<DeezerAlbumFull | null> {
	const res = await fetchWithRetry(`${DEEZER_BASE}/album/${id}`);
	if (!res.ok) return null;
	return (await res.json()) as DeezerAlbumFull;
}

async function checkPreview(
	url: string
): Promise<{ ok: boolean; status: number; contentLength: number | null }> {
	try {
		const res = await fetchWithRetry(url, {
			method: 'GET',
			headers: { Range: 'bytes=0-1' }
		});
		const ok = res.status === 200 || res.status === 206;
		const cl = res.headers.get('content-length');
		// drain body to avoid leaking sockets
		await res.arrayBuffer().catch(() => {});
		return { ok, status: res.status, contentLength: cl ? Number(cl) : null };
	} catch {
		return { ok: false, status: 0, contentLength: null };
	}
}

// ---------------------------------------------------------------------------
// Track probe runner
// ---------------------------------------------------------------------------

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
		let candidates = await searchTrackStrict(probe.artist, probe.expectedTrack);
		let strategy: 'strict' | 'fallback' = 'strict';
		if (candidates.length === 0) {
			candidates = await searchTrackPlain(probe.artist, probe.expectedTrack);
			strategy = 'fallback';
		}

		const match = candidates.find((c) => candidateMatches(c, probe.artist, probe.expectedTrack));
		if (!match) {
			result.failureReason = 'not_found';
			return result;
		}

		result.found = true;
		result.matchedTitle = match.title;
		result.matchedArtist = match.artist?.name;
		result.searchStrategy = strategy;
		result.trackId = match.id;
		result.deezerDuration = match.duration;

		// Preview check
		if (!match.preview) {
			result.previewOk = false;
			result.failureReason = 'no_preview_url';
		} else {
			const previewCheck = await checkPreview(match.preview);
			result.previewOk = previewCheck.ok;
			result.previewStatus = previewCheck.status;
			result.previewContentLength = previewCheck.contentLength;
			if (!previewCheck.ok) {
				result.failureReason = `preview_http_${previewCheck.status}`;
			}
		}

		// Hydration check: track/{id} then album/{id}
		const trackFull = await getTrack(match.id);
		if (!trackFull || !trackFull.album?.id) {
			result.hydrationOk = false;
			if (!result.failureReason) result.failureReason = 'track_hydration_failed';
		} else {
			const album = await getAlbum(trackFull.album.id);
			if (!album) {
				result.hydrationOk = false;
				if (!result.failureReason) result.failureReason = 'album_hydration_failed';
			} else {
				const genres = album.genres?.data?.map((g) => g.name) ?? [];
				result.albumGenres = genres;
				result.albumReleaseDate = album.release_date ?? null;
				result.hydrationOk = genres.length > 0 && !!album.release_date;
				if (!result.hydrationOk && !result.failureReason) {
					result.failureReason = 'missing_genre_or_release_date';
				}
			}
		}

		result.pass = result.found && !!result.previewOk && !!result.hydrationOk;
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		result.failureReason = 'exception';
		return result;
	}
}

// ---------------------------------------------------------------------------
// Artist probe runner
// ---------------------------------------------------------------------------

interface DeezerArtistSearchResponse {
	data: Array<{ id: number; name: string; nb_fan?: number }>;
}

interface DeezerArtistTopResponse {
	data: DeezerTrack[];
}

async function runArtistProbe(
	query: string,
	index: number,
	total: number
): Promise<ArtistProbeResult> {
	process.stderr.write(`[artist ${index + 1}/${total}] ${query}\n`);
	const result: ArtistProbeResult = { query, found: false, pass: false };
	try {
		const res = await fetchWithRetry(`${DEEZER_BASE}/search/artist?q=${encodeURIComponent(query)}`);
		if (!res.ok) {
			result.error = `search http ${res.status}`;
			return result;
		}
		const json = (await res.json()) as DeezerArtistSearchResponse;
		const nq = normalize(query);
		// Multiple homonymous artists can share an exact normalized name (e.g. tribute
		// acts, unrelated small acts). Among exact-name matches, prefer the one with the
		// most fans — that's the plausible "real" hit a human would pick.
		const exactMatches = (json.data ?? []).filter((a) => normalize(a.name) === nq);
		const match =
			exactMatches.length > 0
				? exactMatches.reduce((best, a) => ((a.nb_fan ?? 0) > (best.nb_fan ?? 0) ? a : best))
				: json.data?.[0];
		if (!match) return result;

		result.found = true;
		result.matchedName = match.name;
		result.artistId = match.id;

		const topRes = await fetchWithRetry(`${DEEZER_BASE}/artist/${match.id}/top?limit=25`);
		if (topRes.ok) {
			const topJson = (await topRes.json()) as DeezerArtistTopResponse;
			const tracks = topJson.data ?? [];
			result.topTrackCount = tracks.length;
			result.topTracksWithPreview = tracks.filter((t) => !!t.preview).length;
			result.pass = result.found && tracks.length >= 10;
		}
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Theme probe runner
// ---------------------------------------------------------------------------

// Heuristic set of French-repertoire signal words / known French artists to
// judge "French-language/French-artist plausible" without a language model.
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

function looksFrenchPlausible(track: DeezerTrack): boolean {
	const artistName = normalize(track.artist?.name ?? '');
	if (FRENCH_SIGNAL_ARTISTS.has(artistName)) return true;
	// Heuristic: title contains French diacritics or common French stopwords/patterns
	const raw = `${track.title} ${track.artist?.name ?? ''}`;
	if (/[àâäéèêëïîôöùûüçœæ]/i.test(raw)) return true;
	const nTitle = normalize(track.title);
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

interface DeezerTrackSearchResponse {
	data: DeezerTrack[];
	total?: number;
}

async function runThemeProbe(
	query: string,
	index: number,
	total: number
): Promise<ThemeProbeResult> {
	process.stderr.write(`[theme ${index + 1}/${total}] "${query}"\n`);
	const result: ThemeProbeResult = {
		query,
		totalResults: 0,
		sampledCount: 0,
		frenchPlausibleCount: 0,
		workingPreviewCount: 0,
		usableCount: 0,
		usableRatio: '0/25'
	};
	try {
		const res = await fetchWithRetry(
			`${DEEZER_BASE}/search/track?q=${encodeURIComponent(query)}&limit=25`
		);
		if (!res.ok) {
			result.error = `http ${res.status}`;
			return result;
		}
		const json = (await res.json()) as DeezerTrackSearchResponse;
		const tracks = (json.data ?? []).slice(0, 25);
		result.totalResults = json.total ?? tracks.length;
		result.sampledCount = tracks.length;

		// Check previews for the sampled tracks (throttled, so this is fine even at 25 each)
		const previewChecks = await Promise.all(
			tracks.map(async (t) => {
				const frenchPlausible = looksFrenchPlausible(t);
				let previewOk = false;
				if (t.preview) {
					const check = await checkPreview(t.preview);
					previewOk = check.ok;
				}
				return { frenchPlausible, previewOk };
			})
		);

		result.frenchPlausibleCount = previewChecks.filter((c) => c.frenchPlausible).length;
		result.workingPreviewCount = previewChecks.filter((c) => c.previewOk).length;
		result.usableCount = previewChecks.filter((c) => c.frenchPlausible && c.previewOk).length;
		result.usableRatio = `${result.usableCount}/${result.sampledCount}`;
		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}

// ---------------------------------------------------------------------------
// CORS probe (task 0.5)
// ---------------------------------------------------------------------------

function headersToObject(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	h.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

async function runCorsProbe(
	trackId: number,
	previewUrl: string,
	index: number,
	total: number
): Promise<CorsResult> {
	process.stderr.write(`[cors ${index + 1}/${total}] track ${trackId}\n`);
	const result: CorsResult = { trackId, previewUrl };
	try {
		// Browser-like GET with Origin header (Range to avoid pulling the whole file)
		const getRes = await fetchWithRetry(previewUrl, {
			method: 'GET',
			headers: {
				Origin: 'https://example.com',
				Range: 'bytes=0-1'
			}
		});
		result.getStatus = getRes.status;
		result.getHeaders = headersToObject(getRes.headers);
		await getRes.arrayBuffer().catch(() => {});

		// OPTIONS preflight
		const optRes = await fetchWithRetry(previewUrl, {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://example.com',
				'Access-Control-Request-Method': 'GET'
			}
		});
		result.optionsStatus = optRes.status;
		result.optionsHeaders = headersToObject(optRes.headers);
		await optRes.arrayBuffer().catch(() => {});

		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}

// Full (non-Range) GET on a small subset, per task 0.2 step 3: sanity-check ~30s
// duration from the actual downloaded byte count at Deezer's preview bitrate
// (128 kbps constant — Deezer previews are consistently encoded at this rate).
const PREVIEW_BITRATE_BYTES_PER_SEC = 128_000 / 8;

async function runFullGetDurationCheck(
	trackId: number,
	previewUrl: string
): Promise<{
	trackId: number;
	contentLength: number | null;
	estimatedDurationSec: number | null;
	status: number;
}> {
	try {
		const res = await fetchWithRetry(previewUrl, { method: 'GET' });
		const buf = await res.arrayBuffer();
		const cl = buf.byteLength;
		return {
			trackId,
			contentLength: cl,
			estimatedDurationSec: Math.round((cl / PREVIEW_BITRATE_BYTES_PER_SEC) * 10) / 10,
			status: res.status
		};
	} catch {
		return { trackId, contentLength: null, estimatedDurationSec: null, status: 0 };
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
		`Loaded ${probes.trackProbes.length} track probes, ${probes.artistProbes.length} artist probes, ${probes.themeProbes.length} theme probes\n\n`
	);

	// --- Track probes (sequential-ish via throttle, but fire concurrently and let the throttle gate) ---
	process.stderr.write('=== Track probes ===\n');
	const trackResults: TrackProbeResult[] = [];
	{
		const total = probes.trackProbes.length;
		const promises = probes.trackProbes.map((p, i) => runTrackProbe(p, i, total));
		trackResults.push(...(await Promise.all(promises)));
	}

	// --- Artist probes ---
	process.stderr.write('\n=== Artist probes ===\n');
	const artistResults: ArtistProbeResult[] = [];
	{
		const total = probes.artistProbes.length;
		const promises = probes.artistProbes.map((q, i) => runArtistProbe(q, i, total));
		artistResults.push(...(await Promise.all(promises)));
	}

	// --- Theme probes ---
	process.stderr.write('\n=== Theme probes ===\n');
	const themeResults: ThemeProbeResult[] = [];
	{
		const total = probes.themeProbes.length;
		const promises = probes.themeProbes.map((q, i) => runThemeProbe(q, i, total));
		themeResults.push(...(await Promise.all(promises)));
	}

	// --- CORS probes: sample ~10 preview URLs from successful track probes ---
	process.stderr.write('\n=== CORS probes ===\n');
	const previewSample = trackResults.filter((r) => r.pass && r.trackId).slice(0, 10);
	// Re-fetch preview urls (not stored in result to keep JSON light) — pull from original candidates
	// We need the preview URL; store it during track probe instead. Quick fix: re-search minimal.
	const corsResults: CorsResult[] = [];
	let durationSanity: Array<{
		trackId: number;
		contentLength: number | null;
		estimatedDurationSec: number | null;
		status: number;
	}>;
	{
		const sample = previewSample;
		const withUrls: Array<{ id: number; url: string }> = [];
		for (const r of sample) {
			const t = await getTrack(r.trackId!);
			if (t?.preview) withUrls.push({ id: r.trackId!, url: t.preview });
		}
		const total = withUrls.length;
		const promises = withUrls.map((w, i) => runCorsProbe(w.id, w.url, i, total));
		corsResults.push(...(await Promise.all(promises)));

		// Full (non-Range) GET duration sanity check on a smaller subset (task 0.2 step 3)
		process.stderr.write('\n=== Duration sanity (full GET, no Range) ===\n');
		const durationSubset = withUrls.slice(0, 5);
		const durationPromises = durationSubset.map((w) => runFullGetDurationCheck(w.id, w.url));
		durationSanity = await Promise.all(durationPromises);
		durationSanity.forEach((d) =>
			process.stderr.write(
				`  track ${d.trackId}: ${d.contentLength} bytes ≈ ${d.estimatedDurationSec}s (status ${d.status})\n`
			)
		);
	}

	// --- Summary ---
	const trackTotal = trackResults.length;
	const trackFoundCount = trackResults.filter((r) => r.found).length;
	const trackPreviewOkCount = trackResults.filter((r) => r.previewOk).length;
	const trackHydrationOkCount = trackResults.filter((r) => r.hydrationOk).length;
	const trackCombinedPassCount = trackResults.filter((r) => r.pass).length;

	const artistTotal = artistResults.length;
	const artistPassCount = artistResults.filter((r) => r.pass).length;

	const corsAllOriginPresent = corsResults.filter(
		(r) => !!r.getHeaders?.['access-control-allow-origin']
	).length;

	const results: ProbeResults = {
		runAt: new Date().toISOString(),
		trackProbes: trackResults,
		artistProbes: artistResults,
		themeProbes: themeResults,
		cors: corsResults,
		durationSanity,
		summary: {
			trackTotal,
			trackFoundCount,
			trackFoundRate: pct(trackFoundCount, trackTotal),
			trackPreviewOkCount,
			trackPreviewOkRate: pct(trackPreviewOkCount, trackTotal),
			trackHydrationOkCount,
			trackHydrationOkRate: pct(trackHydrationOkCount, trackTotal),
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
	process.stderr.write(
		`Track: found ${trackFoundCount}/${trackTotal} (${results.summary.trackFoundRate}), preview OK ${trackPreviewOkCount}/${trackTotal} (${results.summary.trackPreviewOkRate}), hydration OK ${trackHydrationOkCount}/${trackTotal} (${results.summary.trackHydrationOkRate})\n`
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
