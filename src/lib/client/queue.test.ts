/**
 * Unit tests for `src/lib/client/queue.ts` (plan task 1.26).
 *
 * `./api.js` is mocked wholesale so these tests never load `./guest.js`
 * (owned by a concurrently-written module) and so backoff/retry behaviour
 * can be driven deterministically with fake timers instead of a real
 * network. `isRetryable` is reimplemented here as a tiny predicate reading a
 * `retryable` flag off the thrown error, matching the real module's
 * network/5xx/429-retryable-else-not contract closely enough for these tests
 * to exercise the same branches in `queue.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => ({
	postRoundStart: vi.fn(),
	postRoundResult: vi.fn(),
	finalizeSession: vi.fn(),
	isRetryable: (err: unknown) => (err as { retryable?: boolean } | undefined)?.retryable !== false
}));

import * as api from './api.js';
import {
	OfflineQueue,
	clearPendingFinalize,
	hasPendingFinalize,
	persistPendingFinalize,
	retryPendingFinalize,
	submitFinalize
} from './queue.js';
import type { RoundResultBody } from '$lib/game/schemas.js';

function retryableError() {
	return Object.assign(new Error('down'), { retryable: true });
}

function nonRetryableError() {
	return Object.assign(new Error('rejected'), { retryable: false, status: 403 });
}

function resultBody(position: number, overrides: Partial<RoundResultBody> = {}): RoundResultBody {
	return { position, guessLog: [], lockTimes: {}, clipMs: 30000, skipped: false, ...overrides };
}

/** In-memory fake matching the `Storage` surface the module relies on. */
function fakeLocalStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => store.clear(),
		key: () => null,
		get length() {
			return store.size;
		}
	} as Storage;
}

describe('queue.ts', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', fakeLocalStorage());
		vi.mocked(api.postRoundStart).mockReset();
		vi.mocked(api.postRoundResult).mockReset();
		vi.mocked(api.finalizeSession).mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	describe('OfflineQueue', () => {
		it('enqueue never throws and flushes results in FIFO order', async () => {
			vi.mocked(api.postRoundResult).mockResolvedValue(undefined);
			const queue = new OfflineQueue();

			expect(() => {
				queue.enqueueRoundResult('s1', resultBody(0));
				queue.enqueueRoundResult('s1', resultBody(1));
				queue.enqueueRoundResult('s1', resultBody(2));
			}).not.toThrow();

			await queue.flush();

			const positions = vi.mocked(api.postRoundResult).mock.calls.map(([, body]) => body.position);
			expect(positions).toEqual([0, 1, 2]);
			expect(queue.pendingResultCount).toBe(0);
		});

		it('retries a failing send with growing exponential backoff', async () => {
			vi.useFakeTimers();
			vi.spyOn(Math, 'random').mockReturnValue(0); // strip jitter for exact delay assertions
			const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

			vi.mocked(api.postRoundResult)
				.mockRejectedValueOnce(retryableError())
				.mockRejectedValueOnce(retryableError())
				.mockResolvedValueOnce(undefined);

			const queue = new OfflineQueue({ maxAttempts: 5 });
			queue.enqueueRoundResult('s1', resultBody(0));

			const flushPromise = queue.flush();
			await vi.runAllTimersAsync();
			await flushPromise;

			expect(api.postRoundResult).toHaveBeenCalledTimes(3);
			expect(queue.pendingResultCount).toBe(0);

			const delays = setTimeoutSpy.mock.calls.map(([, ms]) => ms);
			expect(delays).toEqual([500, 1000]); // 500ms base, doubling, no jitter
		});

		it('drops an item on a non-retryable error instead of blocking the queue head', async () => {
			vi.mocked(api.postRoundResult)
				.mockRejectedValueOnce(nonRetryableError())
				.mockResolvedValueOnce(undefined);

			const queue = new OfflineQueue();
			queue.enqueueRoundResult('s1', resultBody(0)); // will be dropped
			queue.enqueueRoundResult('s1', resultBody(1)); // should still go out

			await queue.flush();

			expect(api.postRoundResult).toHaveBeenCalledTimes(2);
			expect(queue.pendingResultCount).toBe(0);
			const positions = vi.mocked(api.postRoundResult).mock.calls.map(([, body]) => body.position);
			expect(positions).toEqual([0, 1]);
		});

		it('stops at a still-retryable item that exhausted its attempts, leaving it queued', async () => {
			vi.useFakeTimers();
			vi.spyOn(Math, 'random').mockReturnValue(0);
			vi.mocked(api.postRoundResult).mockRejectedValue(retryableError());

			const queue = new OfflineQueue({ maxAttempts: 2 });
			queue.enqueueRoundResult('s1', resultBody(0));
			queue.enqueueRoundResult('s1', resultBody(1));

			const flushPromise = queue.flush();
			await vi.runAllTimersAsync();
			await flushPromise;

			// Only the head item was attempted (2 tries); the second never got sent
			// because ordering is preserved rather than skipping ahead.
			expect(api.postRoundResult).toHaveBeenCalledTimes(2);
			expect(queue.pendingResultCount).toBe(2);
		});

		it('carries an unflushed beacon into the next round-result POST as queuedBeacons', async () => {
			vi.useFakeTimers();
			vi.spyOn(Math, 'random').mockReturnValue(0);
			// The beacon never succeeds on its own within this flush's attempt budget.
			vi.mocked(api.postRoundStart).mockRejectedValue(retryableError());
			vi.mocked(api.postRoundResult).mockResolvedValue(undefined);

			const queue = new OfflineQueue({ maxAttempts: 2 });
			queue.enqueueRoundStart('s1', 3, 12000);
			queue.enqueueRoundResult('s1', resultBody(4));

			const flushPromise = queue.flush();
			await vi.runAllTimersAsync();
			await flushPromise;

			expect(api.postRoundResult).toHaveBeenCalledTimes(1);
			const [, sentBody] = vi.mocked(api.postRoundResult).mock.calls[0];
			expect(sentBody.queuedBeacons).toEqual([{ position: 3, atMs: 12000 }]);

			// Carried and sent along with a successful result — dropped from the
			// standalone beacon queue so it isn't re-sent.
			expect(queue.pendingBeaconCount).toBe(0);
		});

		it("does not carry a different session's unflushed beacon into this result", async () => {
			vi.useFakeTimers();
			vi.spyOn(Math, 'random').mockReturnValue(0);
			vi.mocked(api.postRoundStart).mockRejectedValue(retryableError());
			vi.mocked(api.postRoundResult).mockResolvedValue(undefined);

			const queue = new OfflineQueue({ maxAttempts: 2 });
			queue.enqueueRoundStart('other-session', 0, 1000);
			queue.enqueueRoundResult('s1', resultBody(0));

			const flushPromise = queue.flush();
			await vi.runAllTimersAsync();
			await flushPromise;

			const [, sentBody] = vi.mocked(api.postRoundResult).mock.calls[0];
			expect(sentBody.queuedBeacons).toEqual([]);
			expect(queue.pendingBeaconCount).toBe(1); // the other session's beacon is untouched
		});
	});

	describe('pending finalize', () => {
		it('persists on a retryable failure and is replayed successfully by retryPendingFinalize', async () => {
			vi.mocked(api.finalizeSession).mockRejectedValueOnce(retryableError());

			await expect(submitFinalize('s1', {})).rejects.toThrow();
			expect(hasPendingFinalize()).toBe(true);

			const finalizeResult = { sessionId: 's1', totalScore: 42 } as never;
			vi.mocked(api.finalizeSession).mockResolvedValueOnce(finalizeResult);

			const result = await retryPendingFinalize();

			expect(result).toEqual(finalizeResult);
			expect(api.finalizeSession).toHaveBeenLastCalledWith('s1', {});
			expect(hasPendingFinalize()).toBe(false);
		});

		it('clears the pending finalize on success', async () => {
			vi.mocked(api.finalizeSession).mockResolvedValueOnce({ sessionId: 's1' } as never);

			await submitFinalize('s1', {});

			expect(hasPendingFinalize()).toBe(false);
		});

		it('clears the pending finalize on a non-retryable error (e.g. 403) instead of retrying forever', async () => {
			vi.mocked(api.finalizeSession).mockRejectedValueOnce(nonRetryableError());

			await expect(submitFinalize('s1', {})).rejects.toThrow();

			expect(hasPendingFinalize()).toBe(false);
		});

		it('retryPendingFinalize is a no-op returning null when nothing is pending', async () => {
			const result = await retryPendingFinalize();

			expect(result).toBeNull();
			expect(api.finalizeSession).not.toHaveBeenCalled();
		});

		it('degrades gracefully when localStorage is unavailable', async () => {
			vi.stubGlobal('localStorage', undefined);

			expect(() => persistPendingFinalize('s1', {})).not.toThrow();
			expect(() => clearPendingFinalize()).not.toThrow();
			expect(hasPendingFinalize()).toBe(false);

			vi.mocked(api.finalizeSession).mockRejectedValueOnce(retryableError());
			await expect(submitFinalize('s1', {})).rejects.toThrow();
		});
	});
});
