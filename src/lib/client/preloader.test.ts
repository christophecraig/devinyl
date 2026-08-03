/**
 * Unit tests for the preloader (src/lib/client/preloader.ts): retry/timeout
 * behaviour, the skipped-round path (MUS-5), progress accounting, the
 * >20-round confirmation gate and its persistence, the Save-Data/slow-
 * connection early gate, and concurrency bounding (MUS-7).
 */

import { describe, expect, it, vi } from 'vitest';
import {
	CLIP_TIMEOUT_MS,
	DEFAULT_CONCURRENCY,
	Preloader,
	estimatePreload,
	hasRememberedPreloadConfirmation,
	needsPreloadConfirmation,
	rememberPreloadConfirmation,
	type StorageLike
} from './preloader.js';
import { PRELOAD_CONFIRM_THRESHOLD, type ManifestRound } from '../game/types.js';

function round(position: number, previewUrl: string | null): ManifestRound {
	return { position, previewUrl, skipped: previewUrl === null, choices: null, answerPack: 'pack' };
}

function memoryStorage(): StorageLike {
	const store = new Map<string, string>();
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v)
	};
}

// A minimal ArrayBuffer decode stand-in: buffer "duration" == byte length in seconds,
// so tests can assert on measured clipMs without a real audio stack.
async function fakeDecode(data: ArrayBuffer): Promise<AudioBuffer> {
	return { duration: data.byteLength } as unknown as AudioBuffer;
}

describe('estimatePreload', () => {
	it('matches the §4 budget table order of magnitude: 10 rounds ≈ 5 MB, 50 rounds ≈ 24 MB', () => {
		const ten = estimatePreload(10);
		const fifty = estimatePreload(50);
		expect(ten.bytes / (1024 * 1024)).toBeCloseTo(4.6875, 1);
		expect(fifty.bytes / (1024 * 1024)).toBeCloseTo(23.4375, 1);
		expect(ten.seconds).toBeLessThan(8);
		expect(fifty.seconds).toBeLessThan(40);
	});
});

describe('needsPreloadConfirmation — MUS-7', () => {
	it('is false at or below the threshold with no network signal', () => {
		expect(needsPreloadConfirmation(PRELOAD_CONFIRM_THRESHOLD)).toBe(false);
		expect(needsPreloadConfirmation(5)).toBe(false);
	});

	it('is true above the threshold', () => {
		expect(needsPreloadConfirmation(PRELOAD_CONFIRM_THRESHOLD + 1)).toBe(true);
	});

	it('is raised early by Save-Data regardless of round count', () => {
		expect(needsPreloadConfirmation(5, { saveData: true })).toBe(true);
	});

	it('is raised early by a slow effectiveType regardless of round count', () => {
		expect(needsPreloadConfirmation(5, { effectiveType: '2g' })).toBe(true);
		expect(needsPreloadConfirmation(5, { effectiveType: '3g' })).toBe(true);
		expect(needsPreloadConfirmation(5, { effectiveType: 'slow-2g' })).toBe(true);
	});

	it('degrades gracefully when connection info is absent (Safari) or fast', () => {
		expect(needsPreloadConfirmation(5, {})).toBe(false);
		expect(needsPreloadConfirmation(5, { effectiveType: '4g' })).toBe(false);
		expect(needsPreloadConfirmation(5, undefined)).toBe(false);
	});
});

describe('preload confirmation persistence — remembered per device', () => {
	it('is not remembered until rememberPreloadConfirmation is called', () => {
		const storage = memoryStorage();
		expect(hasRememberedPreloadConfirmation(storage)).toBe(false);
	});

	it('is remembered after confirmation', () => {
		const storage = memoryStorage();
		rememberPreloadConfirmation(storage);
		expect(hasRememberedPreloadConfirmation(storage)).toBe(true);
	});
});

describe('Preloader.load — happy path', () => {
	it('fetches and decodes every clip, reporting a real progress fraction', async () => {
		const fetchFn = vi.fn(
			async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as Response
		);
		const preloader = new Preloader({ fetch: fetchFn, decode: fakeDecode });
		const rounds = [
			round(1, 'https://cdn/1.mp3'),
			round(2, 'https://cdn/2.mp3'),
			round(3, 'https://cdn/3.mp3')
		];

		const fractions: number[] = [];
		const result = await preloader.load(rounds, { onProgress: (p) => fractions.push(p.fraction) });

		expect(result.buffers.size).toBe(3);
		expect(result.skippedPositions).toEqual([]);
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(fractions[0]).toBe(0); // initial emit before any clip settles
		expect(fractions.at(-1)).toBe(1);
		expect(fractions.every((f) => f >= 0 && f <= 1)).toBe(true);
	});

	it('reports the measured buffer duration via the injected decode function', async () => {
		const fetchFn = vi.fn(
			async () =>
				({ ok: true, arrayBuffer: async () => new ArrayBuffer(5000) }) as unknown as Response
		);
		const preloader = new Preloader({ fetch: fetchFn, decode: fakeDecode });
		const result = await preloader.load([round(1, 'https://cdn/1.mp3')]);
		expect(result.buffers.get(1)?.duration).toBe(5000); // fakeDecode: duration == byteLength
	});
});

describe('Preloader.load — MUS-5 skipped-round path', () => {
	it('marks a round with no previewUrl as skipped without any fetch attempt', async () => {
		const fetchFn = vi.fn();
		const preloader = new Preloader({ fetch: fetchFn, decode: fakeDecode });
		const result = await preloader.load([round(1, null)]);
		expect(result.skippedPositions).toEqual([1]);
		expect(result.buffers.size).toBe(0);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('retries exactly once on failure, then marks the round skipped — play continues', async () => {
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			calls++;
			throw new Error('network error');
		});
		const preloader = new Preloader({
			fetch: fetchFn as unknown as typeof fetch,
			decode: fakeDecode
		});
		const statuses: string[] = [];
		const result = await preloader.load([round(1, 'https://cdn/dead.mp3')], {
			onProgress: (p) => statuses.push(p.clips[0].status)
		});

		expect(calls).toBe(2); // one attempt + exactly one retry
		expect(result.skippedPositions).toEqual([1]);
		expect(result.buffers.size).toBe(0);
		expect(statuses).toContain('retrying');
		expect(statuses.at(-1)).toBe('skipped');
	});

	it('succeeds on the retry after one failed attempt', async () => {
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error('flaky');
			return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
		});
		const preloader = new Preloader({
			fetch: fetchFn as unknown as typeof fetch,
			decode: fakeDecode
		});
		const result = await preloader.load([round(1, 'https://cdn/flaky.mp3')]);
		expect(calls).toBe(2);
		expect(result.skippedPositions).toEqual([]);
		expect(result.buffers.size).toBe(1);
	});

	it('treats a non-ok HTTP response as a failure that counts toward the retry budget', async () => {
		const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
		const preloader = new Preloader({ fetch: fetchFn, decode: fakeDecode });
		const result = await preloader.load([round(1, 'https://cdn/404.mp3')]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(result.skippedPositions).toEqual([1]);
	});

	it('treats a decode failure the same as a fetch failure', async () => {
		const fetchFn = vi.fn(
			async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as Response
		);
		const decode = vi.fn(async () => {
			throw new Error('corrupt audio');
		});
		const preloader = new Preloader({ fetch: fetchFn, decode });
		const result = await preloader.load([round(1, 'https://cdn/corrupt.mp3')]);
		expect(decode).toHaveBeenCalledTimes(2);
		expect(result.skippedPositions).toEqual([1]);
	});

	it('one broken clip never blocks the others from loading (a quiz must never dead-end)', async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.includes('dead')) throw new Error('dead clip');
			return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
		});
		const preloader = new Preloader({
			fetch: fetchFn as unknown as typeof fetch,
			decode: fakeDecode
		});
		const rounds = [
			round(1, 'https://cdn/ok1.mp3'),
			round(2, 'https://cdn/dead.mp3'),
			round(3, 'https://cdn/ok3.mp3')
		];
		const result = await preloader.load(rounds);
		expect(result.skippedPositions).toEqual([2]);
		expect([...result.buffers.keys()].sort()).toEqual([1, 3]);
	});

	it('times out a clip that never resolves within CLIP_TIMEOUT_MS, aborting via the fetch signal', async () => {
		vi.useFakeTimers();
		try {
			const fetchFn = vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => {
							const err = new Error('aborted');
							err.name = 'AbortError';
							reject(err);
						});
					})
			);
			const preloader = new Preloader({
				fetch: fetchFn as unknown as typeof fetch,
				decode: fakeDecode
			});
			const loadPromise = preloader.load([round(1, 'https://cdn/hangs.mp3')]);

			await vi.advanceTimersByTimeAsync(CLIP_TIMEOUT_MS + 10);
			await vi.advanceTimersByTimeAsync(CLIP_TIMEOUT_MS + 10);

			const result = await loadPromise;
			expect(result.skippedPositions).toEqual([1]);
			expect(fetchFn).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Preloader.load — concurrency bounding', () => {
	it('never runs more than the configured concurrency in flight at once', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const fetchFn = vi.fn(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 0));
			inFlight--;
			return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
		});
		const preloader = new Preloader({ fetch: fetchFn, decode: fakeDecode });
		const rounds = Array.from({ length: 12 }, (_, i) => round(i + 1, `https://cdn/${i}.mp3`));

		await preloader.load(rounds, { concurrency: 3 });
		expect(maxInFlight).toBeLessThanOrEqual(3);
	});

	it('defaults to DEFAULT_CONCURRENCY when unspecified', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const fetchFn = vi.fn(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 0));
			inFlight--;
			return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response;
		});
		const preloader = new Preloader({ fetch: fetchFn, decode: fakeDecode });
		const rounds = Array.from({ length: 30 }, (_, i) => round(i + 1, `https://cdn/${i}.mp3`));

		await preloader.load(rounds);
		expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
	});
});
