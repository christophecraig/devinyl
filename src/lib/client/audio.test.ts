/**
 * Unit tests for the audio engine (src/lib/client/audio.ts).
 *
 * `AudioContext`/`decodeAudioData` do not exist in the `unit` vitest project
 * (plain node), so every test drives a fake `AudioContextLike` injected via
 * `createContext`. What's exercised here is the logic that's genuinely
 * testable without a real browser audio stack: the unlock contract, the
 * elapsed-time clock derived from a fake `currentTime`, the no-overlap /
 * no-pause API shape, and the `onEnded`/`stop()` distinction. Real-device
 * behaviour is task 1.31 + a separate E2E pass.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	AudioEngine,
	AudioUnlockError,
	type AudioContextLike,
	type AudioBufferSourceNodeLike
} from './audio.js';

function fakeSource(): AudioBufferSourceNodeLike & { started: boolean; stopped: boolean } {
	return {
		buffer: null,
		onended: null,
		started: false,
		stopped: false,
		connect() {},
		start() {
			this.started = true;
		},
		stop() {
			this.stopped = true;
			this.onended?.();
		}
	};
}

function fakeContext(
	opts: { startsSuspended?: boolean; resumeSucceeds?: boolean } = {}
): AudioContextLike & {
	currentTime: number;
	setTime(t: number): void;
} {
	let state: AudioContextLike['state'] = opts.startsSuspended === false ? 'running' : 'suspended';
	let time = 0;
	return {
		get currentTime() {
			return time;
		},
		get state() {
			return state;
		},
		destination: {},
		setTime(t: number) {
			time = t;
		},
		async resume() {
			if (opts.resumeSucceeds === false) return; // stays suspended — simulates a blocked autoplay
			state = 'running';
		},
		async decodeAudioData(data: ArrayBuffer) {
			return { duration: data.byteLength } as unknown as AudioBuffer;
		},
		createBufferSource() {
			return fakeSource();
		},
		async close() {
			state = 'closed';
		}
	};
}

describe('AudioEngine.unlock', () => {
	it('resumes a suspended context and settles running', async () => {
		const ctx = fakeContext({ startsSuspended: true, resumeSucceeds: true });
		const engine = new AudioEngine({ createContext: () => ctx });
		await expect(engine.unlock()).resolves.toBeUndefined();
	});

	it('is a no-op resume when already running', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await expect(engine.unlock()).resolves.toBeUndefined();
	});

	it('throws AudioUnlockError, loudly, when the context stays suspended (blocked autoplay)', async () => {
		const ctx = fakeContext({ startsSuspended: true, resumeSucceeds: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await expect(engine.unlock()).rejects.toBeInstanceOf(AudioUnlockError);
	});

	it('is idempotent — a second unlock() reuses the same context', async () => {
		const create = vi.fn(() => fakeContext({ startsSuspended: false }));
		const engine = new AudioEngine({ createContext: create });
		await engine.unlock();
		await engine.unlock();
		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe('AudioEngine — used-before-unlock guard', () => {
	it('decode() throws before unlock()', async () => {
		const engine = new AudioEngine({
			createContext: () => fakeContext({ startsSuspended: false })
		});
		await expect(engine.decode(new ArrayBuffer(0))).rejects.toThrow(/unlock/i);
	});

	it('play() throws before unlock()', () => {
		const engine = new AudioEngine({
			createContext: () => fakeContext({ startsSuspended: false })
		});
		expect(() => engine.play({ duration: 1 } as unknown as AudioBuffer)).toThrow(/unlock/i);
	});
});

describe('AudioEngine.play / elapsedMs — the clock derives from AudioContext.currentTime', () => {
	it('elapsedMs tracks currentTime, not a wall clock', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();

		const buffer = { duration: 30 } as unknown as AudioBuffer; // 30 000 ms clip
		ctx.setTime(10);
		engine.play(buffer);
		expect(engine.elapsedMs()).toBe(0);

		ctx.setTime(10.5);
		expect(engine.elapsedMs()).toBe(500);
	});

	it('clamps elapsedMs to the measured clip duration and exposes it via clipMs()', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();

		const buffer = { duration: 5 } as unknown as AudioBuffer; // 5 000 ms clip
		engine.play(buffer);
		expect(engine.clipMs()).toBe(5000);

		ctx.setTime(9); // way past the buffer's end
		expect(engine.elapsedMs()).toBeLessThanOrEqual(5000);
	});

	it('elapsedMs is 0 when nothing has played yet', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();
		expect(engine.elapsedMs()).toBe(0);
	});
});

describe('AudioEngine.play — ROUND-2/ROUND-3 API shape', () => {
	it('fires onEnded exactly once when the buffer finishes naturally', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();

		let ended = 0;
		const source = fakeSource();
		ctx.createBufferSource = () => source;
		engine.play({ duration: 1 } as unknown as AudioBuffer, { onEnded: () => ended++ });

		source.onended?.();
		source.onended?.(); // a stray second firing must not double-count
		expect(ended).toBe(1);
	});

	it('stop() ends playback without firing onEnded (early end when all targets lock — ROUND-3)', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();

		let ended = 0;
		const handle = engine.play({ duration: 30 } as unknown as AudioBuffer, {
			onEnded: () => ended++
		});
		handle.stop();
		expect(ended).toBe(0);
	});

	it('rejects overlapping playback — exactly one clip at a time (A11Y-3)', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();
		engine.play({ duration: 30 } as unknown as AudioBuffer);
		expect(() => engine.play({ duration: 30 } as unknown as AudioBuffer)).toThrow();
	});

	it('exposes no pause, seek, or replay method (ROUND-2)', () => {
		const engine = new AudioEngine({
			createContext: () => fakeContext({ startsSuspended: false })
		});
		const surface = engine as unknown as Record<string, unknown>;
		expect(surface.pause).toBeUndefined();
		expect(surface.seek).toBeUndefined();
		expect(surface.replay).toBeUndefined();
		expect(surface.resumePlayback).toBeUndefined();
	});

	it('allows a fresh play() after the previous clip ends', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();
		const handle = engine.play({ duration: 30 } as unknown as AudioBuffer);
		handle.stop();
		expect(() => engine.play({ duration: 30 } as unknown as AudioBuffer)).not.toThrow();
	});
});

describe('AudioEngine.decode', () => {
	it('delegates to the context after unlock', async () => {
		const ctx = fakeContext({ startsSuspended: false });
		const engine = new AudioEngine({ createContext: () => ctx });
		await engine.unlock();
		const buffer = await engine.decode(new ArrayBuffer(16));
		expect((buffer as unknown as { duration: number }).duration).toBe(16);
	});
});
