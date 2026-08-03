/**
 * Gameplay state machine — technical-spec §7.2/§7.4, task 1.23.
 *
 * Drives one played session, round by round: `idle → countdown → clip →
 * reveal → scoreboard → (next round) → summary`, plus the `abandoned`
 * terminal state (ROUND-8). Svelte 5 runes hold the reactive state; every
 * side effect (playing audio, network beacons) is an injected `GamePorts`
 * callback, so this module has no network and no audio hardware dependency
 * and is fully unit-testable with fake ports.
 *
 * Phase transitions are explicit and centralized in `advance()`/the private
 * round-lifecycle helpers below. Calling a method that is not valid for the
 * current phase throws rather than silently no-op-ing — a dropped
 * `advance()` during `clip` is exactly the class of bug (a hung UI) this is
 * meant to make impossible.
 *
 * ## Answer matching and MUS-4
 *
 * The manifest carries zero plaintext answer data (MUS-4): each round's
 * accepted answers travel inside the encrypted `answerPack`, opened via
 * `openRoundPack()` (src/lib/answerpack.ts). §7.2 requires *instant*
 * accept/reject feedback while a clip plays, which needs the decrypted
 * `answers` before the round ends — so this machine opens the pack
 * privately as soon as a round begins (in parallel with `playClip`) and
 * uses `match()` (ANS-4) against it for every `submitGuess()` call.
 *
 * What must not happen before the round ends is *exposure*: the `reveal`
 * metadata (title/artist/cover — the actual spoiler) only lands in the
 * public `revealed` state once the round is over (ROUND-4). Until then the
 * decrypted pack sits in a private field that nothing outside this module
 * can read. `revealed` staying `null` through the whole `clip` phase is
 * what the "answerPack not opened before round end" test asserts.
 *
 * ## Clip duration and natural end — extending GamePorts
 *
 * `RoundResultPayload.clipMs` must be the round's *measured* decoded-buffer
 * duration (§9's curve denominator), not the elapsed time at lock-in — the
 * two differ whenever a round ends early (ROUND-3). The literal `GamePorts`
 * contract (now/playClip/stopClip/onRoundStart/onRoundResult/onComplete)
 * has no channel for that duration, nor for "the clip reached its natural
 * end without every target locking" (the non-early half of ROUND-3,
 * §7.4 "otherwise ends at buffer end") — `playClip`'s promise settles when
 * playback *begins*, not ends, and there is deliberately no `pause`/`seek`/
 * event surface on the audio engine to repurpose (see audio.ts's module
 * doc). Rather than invent a port the concurrently-written `guest.ts` /
 * `api.ts` / `queue.ts` would need to implement identically, this module
 * adds two methods to the returned `Game` beyond the required four —
 * `reportClipDuration()` and `notifyClipEnded()` — for the composing layer
 * (which owns the `AudioBufferSourceNode` and therefore both pieces of
 * information) to call. Both are optional to call from a test's point of
 * view: `reportClipDuration()` falls back to `now()` at round-end if never
 * called, and early end (all targets locked) never needs
 * `notifyClipEnded()` at all.
 */

import type {
	GuessAttempt,
	GuessLog,
	ManifestRound,
	QuizSettings,
	RoundPack,
	RoundResultPayload,
	SessionManifest,
	TargetName
} from '../game/types.js';
import { match } from '../game/match.js';
import { openRoundPack } from '../answerpack.js';

export type GamePhase =
	| 'idle'
	| 'countdown'
	| 'clip'
	| 'reveal'
	| 'scoreboard'
	| 'summary'
	/** ROUND-8: the run was discarded via abandon(). Terminal — every method throws after this. */
	| 'abandoned';

export interface GamePorts {
	/** Elapsed ms within the current clip, from the audio clock. */
	now(): number;
	/** Start playing round n's audio; resolves when playback actually begins. */
	playClip(position: number): Promise<void>;
	stopClip(): void;
	/** Fire-and-forget: round-start beacon. Must never block play. */
	onRoundStart(position: number): void;
	/** Fire-and-forget: completed round result. */
	onRoundResult(payload: RoundResultPayload): void;
	/** All rounds done. */
	onComplete(results: RoundResultPayload[]): void;
}

export interface Game {
	readonly phase: GamePhase;
	readonly roundIndex: number;
	readonly round: ManifestRound | null;
	readonly lockedTargets: TargetName[];
	readonly revealed: RoundPack | null;
	readonly results: RoundResultPayload[];
	readonly totalRoundCount: number;
	start(): void;
	submitGuess(target: TargetName, raw: string): void;
	advance(): void;
	abandon(): void;
	/**
	 * The current clip's measured decoded-buffer duration in ms, from the
	 * composing layer's already-decoded `AudioBuffer` (MUS-7 pre-decodes
	 * every clip). Feeds `RoundResultPayload.clipMs`. Safe to skip in tests —
	 * falls back to `ports.now()` at round end. A no-op outside `countdown`/
	 * `clip` (e.g. a stale call racing a round change).
	 */
	reportClipDuration(clipMs: number): void;
	/**
	 * The clip reached the end of its buffer naturally, without every
	 * required target locking (§7.4 "otherwise ends at buffer end"). A
	 * no-op outside `clip` phase, so a call racing an already-early-ended
	 * round is harmless.
	 */
	notifyClipEnded(): void;
}

/** §6/§7.2 ANS-4: which targets a guess must lock before a round can end. */
function requiredTargetsFor(settings: QuizSettings): TargetName[] {
	if (settings.guessTarget === 'both') return ['title', 'artist'];
	return [settings.guessTarget];
}

interface RoundRuntime {
	guessLog: GuessLog;
	lockTimes: Partial<Record<TargetName, number>>;
	locked: Set<TargetName>;
}

function freshRuntime(): RoundRuntime {
	return { guessLog: [], lockTimes: {}, locked: new Set() };
}

class GameImpl implements Game {
	private readonly manifest: SessionManifest;
	private readonly ports: GamePorts;
	private readonly required: TargetName[];

	private phaseState = $state<GamePhase>('idle');
	private roundIndexState = $state(0);
	private lockedTargetsState = $state<TargetName[]>([]);
	private revealedState = $state<RoundPack | null>(null);
	private resultsState = $state<RoundResultPayload[]>([]);

	/** Decrypted privately at round start (see module doc); never exposed until round end. */
	private currentPack: RoundPack | null = null;
	private runtime: RoundRuntime = freshRuntime();
	private measuredClipMs: number | null = null;

	/**
	 * Bumped on every `beginRound()`/`abandon()` so a stale async
	 * continuation (a slow `playClip`/`openRoundPack` from a round the
	 * player already left, or from before abandonment) can recognize itself
	 * as stale and skip mutating state.
	 */
	private generation = 0;

	constructor(manifest: SessionManifest, ports: GamePorts) {
		if (manifest.rounds.length === 0) {
			throw new Error('createGame: manifest has no rounds');
		}
		this.manifest = manifest;
		this.ports = ports;
		this.required = requiredTargetsFor(manifest.settings);
	}

	get phase(): GamePhase {
		return this.phaseState;
	}
	get roundIndex(): number {
		return this.roundIndexState;
	}
	get round(): ManifestRound | null {
		return this.manifest.rounds[this.roundIndexState] ?? null;
	}
	get lockedTargets(): TargetName[] {
		return this.lockedTargetsState;
	}
	get revealed(): RoundPack | null {
		return this.revealedState;
	}
	get results(): RoundResultPayload[] {
		return this.resultsState;
	}
	get totalRoundCount(): number {
		return this.manifest.rounds.length;
	}

	start(): void {
		if (this.phaseState !== 'idle') {
			throw new Error(`start() is not valid during phase "${this.phaseState}"`);
		}
		this.beginRound(0);
	}

	submitGuess(target: TargetName, raw: string): void {
		if (this.phaseState !== 'clip') {
			throw new Error(`submitGuess() is not valid during phase "${this.phaseState}"`);
		}
		if (!this.required.includes(target)) {
			throw new Error(
				`submitGuess(): "${target}" is not a required target for guessTarget=${this.manifest.settings.guessTarget}`
			);
		}

		const atMs = this.ports.now();
		const attempt: GuessAttempt = { target, raw, atMs };
		// Every attempt is logged — accepted or rejected — so rejected guesses
		// are free retries the server can still see (§7.2, §7.3 step 1).
		this.runtime.guessLog = [...this.runtime.guessLog, attempt];

		if (this.runtime.locked.has(target)) return; // already locked: log only, no re-match needed

		const accepted = this.currentPack !== null && match(raw, this.currentPack.answers[target]);
		if (!accepted) return;

		this.runtime.locked.add(target);
		this.runtime.lockTimes = { ...this.runtime.lockTimes, [target]: atMs };
		this.lockedTargetsState = [...this.runtime.locked];

		const allLocked = this.required.every((t) => this.runtime.locked.has(t));
		if (allLocked) this.endRound(false); // ROUND-3: early end, don't wait out the clip
	}

	advance(): void {
		if (this.phaseState === 'reveal') {
			this.phaseState = 'scoreboard';
			return;
		}
		if (this.phaseState === 'scoreboard') {
			const next = this.roundIndexState + 1;
			if (next >= this.manifest.rounds.length) {
				this.phaseState = 'summary';
				this.ports.onComplete(this.resultsState);
			} else {
				this.beginRound(next);
			}
			return;
		}
		throw new Error(`advance() is not valid during phase "${this.phaseState}"`); // ROUND-6: never silently drop
	}

	abandon(): void {
		if (this.phaseState === 'abandoned') {
			throw new Error('abandon() called on an already-abandoned game');
		}
		if (this.phaseState === 'clip') this.ports.stopClip();
		this.generation++; // invalidate any in-flight beginRound() continuation
		this.phaseState = 'abandoned'; // ROUND-8: unusable from here on, run discarded
	}

	reportClipDuration(clipMs: number): void {
		if (this.phaseState !== 'countdown' && this.phaseState !== 'clip') return;
		this.measuredClipMs = clipMs;
	}

	notifyClipEnded(): void {
		if (this.phaseState !== 'clip') return; // already ended (early) or stale — idempotent
		this.endRound(false);
	}

	/** Starts round `index`: resets per-round state, then either skips straight to reveal or plays the clip. */
	private beginRound(index: number): void {
		const gen = ++this.generation;
		this.roundIndexState = index;
		this.currentPack = null;
		this.runtime = freshRuntime();
		this.lockedTargetsState = [];
		this.revealedState = null;
		this.measuredClipMs = null;

		const round = this.manifest.rounds[index];
		if (!round) throw new Error(`beginRound(): no round at index ${index}`);

		// MUS-5: no preview, or preload already flagged this round unplayable.
		const skipped = round.skipped || round.previewUrl === null;

		this.ports.onRoundStart(round.position);

		if (skipped) {
			this.phaseState = 'countdown'; // transient; endRound() below moves to 'reveal'
			void openRoundPack(this.manifest.sessionSeed, round.position, round.answerPack)
				.catch(() => null) // a corrupt pack on a skipped round still must not hang the run
				.then((pack) => {
					if (gen !== this.generation) return; // superseded by a later round / abandon()
					this.currentPack = pack;
					this.endRound(true);
				});
			return;
		}

		this.phaseState = 'countdown';
		void Promise.all([
			openRoundPack(this.manifest.sessionSeed, round.position, round.answerPack),
			this.ports.playClip(round.position)
		])
			.then(([pack]) => {
				if (gen !== this.generation) return; // superseded
				this.currentPack = pack;
				this.phaseState = 'clip';
			})
			.catch(() => {
				// A clip that fails to open/play mid-flight cannot be played fairly —
				// fall back to the skipped path rather than hanging in 'countdown'.
				if (gen !== this.generation) return;
				this.endRound(true);
			});
	}

	/** Ends the current round (early lock, natural buffer end, or skip) and opens `reveal`. */
	private endRound(skipped: boolean): void {
		if (this.phaseState === 'clip') this.ports.stopClip();

		const round = this.manifest.rounds[this.roundIndexState];
		const clipMs = skipped ? 0 : (this.measuredClipMs ?? this.ports.now());

		const payload: RoundResultPayload = {
			position: round.position,
			guessLog: this.runtime.guessLog,
			lockTimes: this.runtime.lockTimes,
			clipMs,
			skipped
		};

		this.revealedState = this.currentPack; // ROUND-4: exposed only now, round is over
		this.resultsState = [...this.resultsState, payload];
		this.phaseState = 'reveal';
		this.ports.onRoundResult(payload);
	}
}

export function createGame(manifest: SessionManifest, ports: GamePorts): Game {
	return new GameImpl(manifest, ports);
}
