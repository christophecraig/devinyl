/**
 * Audio engine — technical-spec §4 "Audio engine", §7.4, ROUND-2, ROUND-3, A11Y-3.
 *
 * This is the highest-risk component in the product: speed scoring is only as
 * honest as this clock. Design invariants, enforced by the API shape rather
 * than by convention:
 *
 *   - **The round clock derives from `AudioContext.currentTime`, never
 *     `Date.now()`.** `currentTime` advances on the audio hardware clock and
 *     is immune to main-thread jank, which is what keeps speed scoring honest
 *     on a slow phone under load. See `elapsedMs()`.
 *   - **No pause, no replay, no scrub (ROUND-2).** The only playback controls
 *     this module exposes are `play()` (once) and `stop()` (early end when
 *     all targets lock, ROUND-3). There is deliberately no `pause`, `seek`,
 *     or "play again" — that is a hard functional requirement, not a default
 *     we forgot to add.
 *   - **The audio channel belongs to the clip (A11Y-3).** This module plays
 *     exactly one thing at a time — the round's clip — and nothing else,
 *     ever. Do not repurpose `AudioEngine` for UI sound effects.
 *   - **iOS Safari autoplay policy.** `AudioContext` must be created *and*
 *     resumed synchronously inside the user's "start quiz" tap gesture, or
 *     the browser silently refuses to produce sound. `unlock()` is the only
 *     way to obtain a working engine: call it directly from the tap handler,
 *     before anything else touches audio. It throws `AudioUnlockError` if the
 *     context is not `running` afterwards, so a failed unlock is loud, not a
 *     silent dead quiz — see task 1.31 for the real-device smoke test this
 *     is guarding against.
 */

/** Minimal surface of `AudioBufferSourceNode` this module depends on — lets tests supply a fake. */
export interface AudioBufferSourceNodeLike {
	buffer: AudioBuffer | null;
	onended: (() => void) | null;
	connect(destination: unknown): void;
	start(when?: number): void;
	stop(when?: number): void;
}

/** Minimal surface of `AudioContext` this module depends on — lets tests supply a fake. */
export interface AudioContextLike {
	readonly currentTime: number;
	readonly state: 'suspended' | 'running' | 'closed';
	readonly destination: unknown;
	resume(): Promise<void>;
	decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
	createBufferSource(): AudioBufferSourceNodeLike;
	close(): Promise<void>;
}

export interface AudioEngineDeps {
	/** Factory rather than an instance: the context must be constructed inside the unlock gesture. */
	createContext: () => AudioContextLike;
}

function defaultCreateContext(): AudioContextLike {
	// Safari historically required the `webkit`-prefixed constructor; feature-detect rather
	// than assume. Cast is confined to this one boundary line.
	const Ctor =
		(globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext ??
		(globalThis as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
	if (!Ctor) throw new Error('AudioContext is not available in this environment');
	return new Ctor();
}

/**
 * Thrown by `unlock()` when the context is not `running` afterwards. iOS
 * Safari refuses to start audio outside a user gesture and fails *silently*
 * — no exception, no sound, no obvious signal — unless we check ourselves.
 */
export class AudioUnlockError extends Error {
	constructor(state: string) {
		super(
			`AudioContext failed to unlock (state="${state}"). unlock() must be called ` +
				'synchronously from within a user-initiated gesture handler (e.g. the "start quiz" ' +
				'tap), before any await — iOS Safari silently refuses autoplay otherwise.'
		);
		this.name = 'AudioUnlockError';
	}
}

/** Returned by `play()`. The only control surface during playback — see ROUND-2 in the module doc. */
export interface PlaybackHandle {
	/** Stops the clip immediately (ROUND-3: all targets locked). Does not fire `onEnded`. */
	stop(): void;
}

export interface PlayOptions {
	/** Fired once when the buffer finishes naturally (not via `stop()`) — ROUND-3. */
	onEnded?: () => void;
}

/**
 * Fetches, decodes and plays exactly one clip per round. Fetching lives in
 * `preloader.ts` (task 1.22), which calls `decode()` on this same engine so
 * every clip is decoded through the one unlocked `AudioContext` — decoding
 * happens ahead of round 1, playback happens once per round.
 */
export class AudioEngine {
	private readonly deps: AudioEngineDeps;
	private ctx: AudioContextLike | null = null;
	private activeSource: AudioBufferSourceNodeLike | null = null;
	private startedAtCtxTime: number | null = null;
	private activeClipMs = 0;

	constructor(deps: Partial<AudioEngineDeps> = {}) {
		this.deps = { createContext: deps.createContext ?? defaultCreateContext };
	}

	/**
	 * Creates and resumes the `AudioContext`. **Must be called synchronously
	 * from within the user's "start quiz" tap handler**, before any other
	 * method on this class. Throws `AudioUnlockError` if the context is not
	 * `running` once resume settles — never fails silently.
	 */
	async unlock(): Promise<void> {
		if (!this.ctx) this.ctx = this.deps.createContext();
		if (this.ctx.state === 'suspended') await this.ctx.resume();
		if (this.ctx.state !== ('running' as AudioContextLike['state'])) {
			throw new AudioUnlockError(this.ctx.state);
		}
	}

	private requireContext(): AudioContextLike {
		if (!this.ctx) {
			throw new Error(
				'AudioEngine used before unlock() — see the iOS autoplay note in the module doc.'
			);
		}
		return this.ctx;
	}

	/**
	 * Decodes a fetched clip. Exposed so the preloader can decode every clip
	 * of a session through this engine's single `AudioContext` ahead of round
	 * 1, without re-fetching at play time.
	 */
	async decode(data: ArrayBuffer): Promise<AudioBuffer> {
		return this.requireContext().decodeAudioData(data);
	}

	/**
	 * Plays a decoded buffer once, from its start, for its full duration —
	 * ROUND-2. Throws if a clip is already playing (this engine never
	 * overlaps playback — A11Y-3).
	 */
	play(buffer: AudioBuffer, opts: PlayOptions = {}): PlaybackHandle {
		const ctx = this.requireContext();
		if (this.activeSource) {
			throw new Error('AudioEngine.play() called while a clip is already playing');
		}

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);

		let settled = false;
		source.onended = () => {
			if (settled) return; // stop() already tore this down
			settled = true;
			this.activeSource = null;
			opts.onEnded?.();
		};

		this.startedAtCtxTime = ctx.currentTime;
		this.activeClipMs = buffer.duration * 1000;
		this.activeSource = source;
		source.start(0);

		return {
			stop: () => {
				if (settled) return;
				settled = true;
				this.activeSource = null;
				source.onended = null;
				source.stop();
			}
		};
	}

	/**
	 * Elapsed time since the active clip's `start()`, in ms, derived from
	 * `AudioContext.currentTime` — never `Date.now()`. This is the number the
	 * answer layer timestamps guesses against and the scoring curve consumes.
	 * Clamped to the clip's measured duration; `0` when nothing is playing.
	 */
	elapsedMs(): number {
		if (!this.ctx || this.startedAtCtxTime === null) return 0;
		const elapsed = (this.ctx.currentTime - this.startedAtCtxTime) * 1000;
		return Math.max(0, Math.min(elapsed, this.activeClipMs));
	}

	/**
	 * The active (or most recently played) clip's measured duration in ms —
	 * `audioBuffer.duration * 1000`, not a hardcoded 30 000 (§9). This is what
	 * gets reported to the server as `RoundResultPayload.clipMs`.
	 */
	clipMs(): number {
		return this.activeClipMs;
	}

	/** Releases the underlying `AudioContext`. Call once, at session end. */
	async close(): Promise<void> {
		if (!this.ctx) return;
		this.activeSource = null;
		await this.ctx.close();
	}
}
