/**
 * Offline resilience — technical-spec §4, plan task 1.26.
 *
 * "Round-start beacons and round results queue in memory and flush with
 * retry/backoff; a session finalize that keeps failing is retried from
 * localStorage on next visit... A run played through a drop is still
 * scorable — it falls to the reconstructed-timing tier of §7.3, not straight
 * to unscored." That reconstructed tier is exactly why unflushed beacons
 * aren't just retried forever as standalone calls: `roundResultSchema`
 * carries a `queuedBeacons` field precisely so a beacon that never reached
 * the server on its own can still ride along with the next result and keep
 * the round eligible for reconstruction (see the result route handler).
 *
 * Enqueue is synchronous, never throws, and never awaits the network —
 * gameplay must never stall on connectivity (MUS-7). `flush()` is the only
 * thing that talks to the network here, and it is meant to be called
 * opportunistically (e.g. on an interval, or on `online`), not awaited by
 * the round-advance path.
 */

import { finalizeSession, isRetryable, postRoundResult, postRoundStart } from './api.js';
import type { FinalizeSessionBody, RoundResultBody } from '$lib/game/schemas.js';
import type { FinalizeResult } from '$lib/game/types.js';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
/**
 * Bounds retries *within one `flush()` call*. Exhausting it for a still-
 * retryable failure is not a drop — the item stays at the head of the queue
 * for the next `flush()` (e.g. the next `online` event), it just stops
 * blocking this call forever.
 */
const DEFAULT_MAX_ATTEMPTS = 5;

interface PendingBeacon {
	sessionId: string;
	position: number;
	atMs: number;
}

interface PendingResult {
	sessionId: string;
	body: RoundResultBody;
}

type SendOutcome<T> =
	{ ok: true; value: T } | { ok: false; retryable: false } | { ok: false; retryable: true };

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff from `BASE_DELAY_MS`, capped at `MAX_DELAY_MS`, with up to 25% jitter so a reconnect doesn't thundering-herd every queued item at once. */
function backoffDelayMs(attempt: number): number {
	const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
	return base + base * 0.25 * Math.random();
}

async function sendWithBackoff<T>(
	fn: () => Promise<T>,
	maxAttempts: number
): Promise<SendOutcome<T>> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const value = await fn();
			return { ok: true, value };
		} catch (err) {
			if (!isRetryable(err)) {
				return { ok: false, retryable: false };
			}
			if (attempt === maxAttempts) {
				return { ok: false, retryable: true };
			}
			await delay(backoffDelayMs(attempt));
		}
	}
	// Unreachable (maxAttempts >= 1 always returns above), but keeps TS happy.
	return { ok: false, retryable: true };
}

/**
 * A single offline queue instance. Exported as a class (rather than only a
 * module-singleton) so tests can create isolated instances; `offlineQueue`
 * below is the one the app actually uses.
 */
export class OfflineQueue {
	private beacons: PendingBeacon[] = [];
	private results: PendingResult[] = [];
	private readonly maxAttempts: number;

	constructor(opts: { maxAttempts?: number } = {}) {
		this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	}

	/** Never throws, never awaits — safe to call from the hot round-start path. */
	enqueueRoundStart(sessionId: string, position: number, atMs: number): void {
		this.beacons.push({ sessionId, position, atMs });
	}

	/** Never throws, never awaits — safe to call from the hot round-result path. */
	enqueueRoundResult(sessionId: string, body: RoundResultBody): void {
		this.results.push({ sessionId, body });
	}

	/** Read-only snapshots for callers/tests inspecting queue depth. */
	get pendingBeaconCount(): number {
		return this.beacons.length;
	}

	get pendingResultCount(): number {
		return this.results.length;
	}

	/**
	 * Drains beacons first, then results (carrying any beacons still stuck
	 * after their own flush attempt along in each result's `queuedBeacons`).
	 * Stops at the first item whose retries were exhausted while still
	 * retryable, preserving FIFO order — everything behind it waits for the
	 * next `flush()` rather than being sent out of order.
	 */
	async flush(): Promise<void> {
		await this.flushBeacons();
		await this.flushResults();
	}

	private async flushBeacons(): Promise<void> {
		while (this.beacons.length > 0) {
			const next = this.beacons[0];
			const outcome = await sendWithBackoff(
				() => postRoundStart(next.sessionId, next.position),
				this.maxAttempts
			);

			if (outcome.ok || !outcome.retryable) {
				// Sent, or a non-retryable ApiError (e.g. the session is gone) — either
				// way this beacon is done. A failed-but-non-retryable beacon is simply
				// dropped: there's nothing a `queuedBeacons` carry-forward would fix
				// about a request the server will never accept.
				this.beacons.shift();
				continue;
			}

			// Still retryable but out of attempts for this flush() call — leave it
			// queued. It will still ride along with the next round-result POST via
			// flushResults()'s carry-forward below, even though its own standalone
			// send hasn't succeeded yet.
			return;
		}
	}

	private async flushResults(): Promise<void> {
		while (this.results.length > 0) {
			const next = this.results[0];
			const carried = this.beacons.filter((b) => b.sessionId === next.sessionId);
			const body: RoundResultBody = {
				...next.body,
				queuedBeacons: [
					...(next.body.queuedBeacons ?? []),
					...carried.map((b) => ({ position: b.position, atMs: b.atMs }))
				]
			};

			const outcome = await sendWithBackoff(
				() => postRoundResult(next.sessionId, body),
				this.maxAttempts
			);

			if (outcome.ok) {
				this.results.shift();
				// The server merged the carried beacons into this result — drop them
				// from the standalone beacon queue so they aren't sent twice.
				this.beacons = this.beacons.filter(
					(b) => b.sessionId !== next.sessionId || !carried.includes(b)
				);
				continue;
			}

			if (!outcome.retryable) {
				// A 4xx that will never succeed (e.g. a stale/finalized session) —
				// drop the result rather than block everything behind it. The
				// carried beacons stay queued; they're still meaningful for a
				// *different* still-open session's next result.
				this.results.shift();
				continue;
			}

			// Retryable, out of attempts this call — leave head-of-queue for next flush().
			return;
		}
	}
}

/** The instance the app uses. Tests should construct their own `OfflineQueue` instead of sharing this. */
export const offlineQueue = new OfflineQueue();

// ---------------------------------------------------------------------------
// Pending finalize — the one queue item that must survive a page close (§4).
// ---------------------------------------------------------------------------

const PENDING_FINALIZE_KEY = 'devinyl:pending-finalize:v1';

interface PendingFinalize {
	sessionId: string;
	body: FinalizeSessionBody;
}

/** `localStorage` can throw (Safari private mode, disabled storage, quota) — every access here degrades to a no-op rather than crashing the game. */
function getStorage(): Storage | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage;
	} catch {
		return null;
	}
}

function readPendingFinalize(): PendingFinalize | null {
	const storage = getStorage();
	if (!storage) return null;
	try {
		const raw = storage.getItem(PENDING_FINALIZE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as PendingFinalize;
	} catch {
		return null;
	}
}

function writePendingFinalize(pending: PendingFinalize): void {
	const storage = getStorage();
	if (!storage) return;
	try {
		storage.setItem(PENDING_FINALIZE_KEY, JSON.stringify(pending));
	} catch {
		// Storage full/unavailable — the in-flight attempt below still happens;
		// only the "survive a page close" guarantee is lost, silently.
	}
}

/** Exported for tests and for callers that want to persist without an immediate send attempt (e.g. right before a known-risky unload). */
export function persistPendingFinalize(sessionId: string, body: FinalizeSessionBody): void {
	writePendingFinalize({ sessionId, body });
}

export function clearPendingFinalize(): void {
	const storage = getStorage();
	if (!storage) return;
	try {
		storage.removeItem(PENDING_FINALIZE_KEY);
	} catch {
		// Nothing more to do; worst case a stale entry is retried and no-ops
		// against an already-finalized session.
	}
}

export function hasPendingFinalize(): boolean {
	return readPendingFinalize() !== null;
}

/**
 * Persist-then-send: the write happens *before* the network call so a page
 * close mid-request still leaves the pending finalize behind for
 * `retryPendingFinalize()` on the next visit. Cleared on success and on a
 * non-retryable error (a 403/409 finalize will never succeed — retrying it
 * forever would be a bug, not resilience).
 */
export async function submitFinalize(
	sessionId: string,
	body: FinalizeSessionBody
): Promise<FinalizeResult> {
	persistPendingFinalize(sessionId, body);
	try {
		const result = await finalizeSession(sessionId, body);
		clearPendingFinalize();
		return result;
	} catch (err) {
		if (!isRetryable(err)) {
			clearPendingFinalize();
		}
		throw err;
	}
}

/**
 * Called on next visit (§4). Returns `null` when there is nothing pending —
 * the common case — rather than throwing, so callers can invoke it
 * unconditionally on load.
 */
export async function retryPendingFinalize(): Promise<FinalizeResult | null> {
	const pending = readPendingFinalize();
	if (!pending) return null;

	try {
		const result = await finalizeSession(pending.sessionId, pending.body);
		clearPendingFinalize();
		return result;
	} catch (err) {
		if (!isRetryable(err)) {
			clearPendingFinalize();
		}
		throw err;
	}
}
