/**
 * Preloader — technical-spec §4 "Offline resilience" + performance-budget table, §7.4, MUS-5, MUS-7.
 *
 * Fetches and decodes every clip of a session in parallel behind a loading
 * screen, before round 1, so that:
 *
 *   - speed scoring never suffers a mid-round network stall (MUS-7);
 *   - a connection drop mid-quiz never interrupts play — everything is
 *     already in memory (§4 offline resilience);
 *   - a broken clip degrades to a **skipped round** rather than a dead quiz
 *     (MUS-5) — the preloader never throws on a single clip's failure.
 *
 * Decoding is delegated to an injected `decode` function (in production,
 * `AudioEngine.decode`, task 1.21) so every clip is decoded through the one
 * unlocked `AudioContext` rather than each module creating its own.
 */

import { PRELOAD_CONFIRM_THRESHOLD, type ManifestRound } from '../game/types.js';

// ---------------------------------------------------------------------------
// Budget constants — technical-spec §4 performance-budget table.
// ---------------------------------------------------------------------------

/** ~480 KB/clip @128 kbps (§4). */
export const BYTES_PER_CLIP_ESTIMATE = 480 * 1024;

/**
 * Throughput assumption behind the budget table's targets (10 rounds/~5 MB/<8s,
 * 50 rounds/~24 MB/<40s on 4G) — used only to *estimate* download time for the
 * confirmation prompt, not to bound anything at runtime.
 */
const ASSUMED_BYTES_PER_SECOND_4G = 640 * 1024;

/** 10 s timeout + exactly one retry per clip (§4). */
export const CLIP_TIMEOUT_MS = 10_000;

/** Sensible parallelism against a CDN that enforces its own rate limit (Phase 0 probe). */
export const DEFAULT_CONCURRENCY = 5;

/** `navigator.connection.effectiveType` values treated as "slow" for the early confirmation gate. */
const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g']);

/** Per-device "don't ask me again" flag for the >20-round confirmation (MUS-7). */
export const PRELOAD_CONFIRM_STORAGE_KEY = 'devinyl:preload-confirm-large-quiz';

// ---------------------------------------------------------------------------
// Confirmation gate — MUS-7 (>20 rounds, or Save-Data / slow connection early)
// ---------------------------------------------------------------------------

export interface PreloadEstimate {
	bytes: number;
	/** Estimated download time on 4G, in seconds. */
	seconds: number;
}

/** Estimates download size/time for `roundCount` clips, for the confirmation prompt's copy. */
export function estimatePreload(roundCount: number): PreloadEstimate {
	const bytes = roundCount * BYTES_PER_CLIP_ESTIMATE;
	return { bytes, seconds: bytes / ASSUMED_BYTES_PER_SECOND_4G };
}

/**
 * Subset of `navigator.connection` this module reads. Optional and
 * feature-detected everywhere it's used — Safari has neither API.
 */
export interface NetworkInfoLike {
	saveData?: boolean;
	effectiveType?: string;
}

/**
 * Whether the app must show the size/time estimate and block on explicit
 * confirmation before starting preload. True above the round-count threshold
 * (MUS-7), and raised *early* — regardless of round count — when the browser
 * reports `Save-Data: on` or a slow `effectiveType` (§4).
 */
export function needsPreloadConfirmation(roundCount: number, network?: NetworkInfoLike): boolean {
	if (roundCount > PRELOAD_CONFIRM_THRESHOLD) return true;
	if (!network) return false;
	if (network.saveData) return true;
	if (network.effectiveType && SLOW_EFFECTIVE_TYPES.has(network.effectiveType)) return true;
	return false;
}

/** Minimal `localStorage` surface — lets tests supply an in-memory fake. */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Whether this device already confirmed a large/slow preload previously (MUS-7: "remember the choice per device"). */
export function hasRememberedPreloadConfirmation(storage: StorageLike): boolean {
	return storage.getItem(PRELOAD_CONFIRM_STORAGE_KEY) === '1';
}

/** Records that this device confirmed a large/slow preload, so future sessions skip the prompt. */
export function rememberPreloadConfirmation(storage: StorageLike): void {
	storage.setItem(PRELOAD_CONFIRM_STORAGE_KEY, '1');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type ClipLoadStatus = 'pending' | 'loading' | 'retrying' | 'loaded' | 'skipped';

export interface ClipLoadState {
	position: number;
	status: ClipLoadStatus;
}

/** Granular progress for a real progress bar + a11y announcements (MUS-7). */
export interface PreloadProgress {
	/** Clips that have reached a terminal state (`loaded` or `skipped`). */
	settled: number;
	total: number;
	/** `settled / total`, `0` when `total` is `0`. */
	fraction: number;
	clips: ClipLoadState[];
}

export interface PreloadResult {
	/** Decoded buffers keyed by round position. A position missing here was skipped. */
	buffers: Map<number, AudioBuffer>;
	/** Positions that failed to load (or had no `previewUrl` to begin with) — MUS-5. */
	skippedPositions: number[];
}

export interface PreloaderDeps {
	fetch: typeof fetch;
	/** In production, `AudioEngine.decode` — see module doc. */
	decode: (data: ArrayBuffer) => Promise<AudioBuffer>;
}

export interface LoadOptions {
	concurrency?: number;
	onProgress?: (progress: PreloadProgress) => void;
}

async function fetchArrayBuffer(
	fetchFn: typeof fetch,
	url: string,
	timeoutMs: number
): Promise<ArrayBuffer> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchFn(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`preload fetch failed: HTTP ${res.status}`);
		return await res.arrayBuffer();
	} finally {
		clearTimeout(timer);
	}
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	if (items.length === 0) return;
	let cursor = 0;
	const lane = async (): Promise<void> => {
		while (cursor < items.length) {
			const item = items[cursor++];
			await worker(item);
		}
	};
	const lanes = Array.from({ length: Math.min(limit, items.length) }, () => lane());
	await Promise.all(lanes);
}

export class Preloader {
	private readonly deps: PreloaderDeps;

	constructor(deps: PreloaderDeps) {
		this.deps = deps;
	}

	/**
	 * Fetches + decodes every round's clip in parallel. Rounds with no
	 * `previewUrl` (already known-dead per MUS-5's assembly-time check) and
	 * rounds whose clip fails a 10 s timeout + one retry are both reported as
	 * skipped — this method never rejects on a single clip's failure, only on
	 * a fatal setup error.
	 */
	async load(rounds: ManifestRound[], options: LoadOptions = {}): Promise<PreloadResult> {
		const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
		const states = new Map<number, ClipLoadState>(
			rounds.map((r) => [
				r.position,
				{ position: r.position, status: r.previewUrl ? 'pending' : 'skipped' }
			])
		);
		const buffers = new Map<number, AudioBuffer>();

		const emit = (): void => {
			if (!options.onProgress) return;
			const clips = [...states.values()].sort((a, b) => a.position - b.position);
			const settled = clips.filter((c) => c.status === 'loaded' || c.status === 'skipped').length;
			options.onProgress({
				settled,
				total: clips.length,
				fraction: clips.length ? settled / clips.length : 0,
				clips
			});
		};
		emit();

		const loadable = rounds.filter((r) => r.previewUrl);
		await runPool(loadable, concurrency, async (round) => {
			const state = states.get(round.position);
			if (!state) return;
			const buffer = await this.loadOneClip(round.previewUrl as string, state, emit);
			if (buffer) {
				state.status = 'loaded';
				buffers.set(round.position, buffer);
			} else {
				state.status = 'skipped';
			}
			emit();
		});

		const skippedPositions = [...states.values()]
			.filter((s) => s.status === 'skipped')
			.map((s) => s.position)
			.sort((a, b) => a - b);

		return { buffers, skippedPositions };
	}

	/** One clip, one 10 s-timeout attempt, exactly one retry, then give up (§4). */
	private async loadOneClip(
		url: string,
		state: ClipLoadState,
		emit: () => void
	): Promise<AudioBuffer | null> {
		const attempts = 2;
		for (let attempt = 0; attempt < attempts; attempt++) {
			state.status = attempt === 0 ? 'loading' : 'retrying';
			emit();
			try {
				const data = await fetchArrayBuffer(this.deps.fetch, url, CLIP_TIMEOUT_MS);
				return await this.deps.decode(data);
			} catch {
				// Swallow and retry once; final failure is reported by the caller as `skipped`.
			}
		}
		return null;
	}
}
