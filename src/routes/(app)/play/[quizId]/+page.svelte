<script lang="ts">
	/**
	 * Play — SOLO-1/2, technical-spec §7.1/§7.2/§7.4, plan task 1.28.
	 *
	 * This is the composition root: every module task 1.20-1.27 built stays
	 * untouched here, wired together through `GamePorts` and the DOM. Summary
	 * is a phase of this same route (`game.phase === 'summary'`) rather than a
	 * separate route — the state machine already models it as a terminal phase
	 * with `game.results` in hand, and a second route would just have to
	 * re-fetch or prop-drill the same session/manifest/results this one
	 * already holds in memory. Splitting it would buy nothing and would cost a
	 * navigation that risks losing an unflushed `results` array.
	 *
	 * ## iOS audio unlock — the single most fragile wire in this file
	 *
	 * `AudioEngine.unlock()` creates and resumes the `AudioContext`, and iOS
	 * Safari's autoplay policy only allows that from *inside* a user gesture's
	 * call stack, synchronously, before any `await`. `handleStartTap` below is
	 * that gesture handler: its first statement is the synchronous call to
	 * `audio.unlock()` (the returned promise is only *awaited* afterwards, in
	 * `runStart`). Moving that call one line later, or awaiting anything
	 * before it, silently breaks sound on iOS with no error — see
	 * `audio.ts`'s module doc and plan task 1.31's real-device smoke test.
	 * `PreloadGate`'s `confirm` screen reuses this exact handler as its own
	 * button's `onclick`, so the confirm tap *is* the unlock gesture when a
	 * confirmation is shown — there is never a second, later tap that would
	 * have lost the gesture context.
	 */
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import LiveRegion from '$lib/components/LiveRegion.svelte';
	import NicknamePrompt from '$lib/components/NicknamePrompt.svelte';
	import PreloadGate from '$lib/components/PreloadGate.svelte';
	import RoundReveal from '$lib/components/RoundReveal.svelte';
	import TextAnswer from '$lib/components/TextAnswer.svelte';
	import ChoiceAnswer from '$lib/components/ChoiceAnswer.svelte';
	import { AudioEngine, type PlaybackHandle } from '$lib/client/audio.js';
	import {
		Preloader,
		estimatePreload,
		needsPreloadConfirmation,
		hasRememberedPreloadConfirmation,
		rememberPreloadConfirmation,
		type PreloadProgress,
		type NetworkInfoLike
	} from '$lib/client/preloader.js';
	import { createGame, type Game, type GamePorts } from '$lib/client/game-state.svelte.js';
	import { createAnnouncer, focusFirst } from '$lib/client/a11y.svelte.js';
	import { createSession, ApiError } from '$lib/client/api.js';
	import { offlineQueue, submitFinalize, retryPendingFinalize } from '$lib/client/queue.js';
	import { loadGuest, setNickname, recordPlay } from '$lib/client/guest.js';
	import { getCurve } from '$lib/game/scoring.js';
	import type {
		FinalizeResult,
		ManifestRound,
		RoundResultPayload,
		SessionManifest,
		TargetName
	} from '$lib/game/types.js';

	const quizId = page.params.quizId as string;

	// ---------------------------------------------------------------------------
	// Guest identity + session creation
	// ---------------------------------------------------------------------------

	let mounted = $state(false);
	let nickname = $state<string | null>(null);
	let manifest = $state<SessionManifest | null>(null);
	let sessionLoading = $state(false);
	let sessionError = $state<ApiError | null>(null);

	function ensureSession(): void {
		if (manifest || sessionLoading) return;
		sessionLoading = true;
		sessionError = null;
		createSession({ quizId, nickname: nickname ?? undefined })
			.then((m) => {
				manifest = m;
			})
			.catch((err: unknown) => {
				sessionError =
					err instanceof ApiError ? err : new ApiError(0, 'network_error', 'Network error.');
			})
			.finally(() => {
				sessionLoading = false;
			});
	}

	function handleNicknameSubmit(name: string): void {
		setNickname(name);
		nickname = name;
		ensureSession();
	}

	onMount(() => {
		// Offline resilience (§4): a finalize that failed on a *previous* visit
		// is retried here, independently of this page's own session — it must
		// never block this run's own flow, so its outcome only ever surfaces as
		// an informational banner.
		retryPendingFinalize()
			.then((recovered) => {
				if (recovered) recoveredFinalize = recovered;
			})
			.catch(() => {
				// A retry that fails stays queued for the next visit; nothing to
				// show here beyond what `submitFinalize` already persisted.
			});

		nickname = loadGuest().nickname;
		mounted = true;
		if (nickname) ensureSession();
	});

	let recoveredFinalize = $state<FinalizeResult | null>(null);

	// ---------------------------------------------------------------------------
	// Audio, preload, announcer — constructed once per page instance.
	// ---------------------------------------------------------------------------

	const audio = new AudioEngine();
	const announcer = createAnnouncer();
	const preloader = new Preloader({ fetch, decode: (data) => audio.decode(data) });

	onMount(() => () => {
		void audio.close();
	});

	type PreloadPhase = 'start' | 'confirm' | 'loading';
	let preloadPhase = $state<PreloadPhase>('start');
	let preloadProgress = $state<PreloadProgress | null>(null);
	let buffers = new Map<number, AudioBuffer>();

	function connectionInfo(): NetworkInfoLike | undefined {
		const nav = navigator as Navigator & { connection?: NetworkInfoLike };
		return nav.connection;
	}

	$effect(() => {
		if (!manifest) return;
		const remembered =
			typeof localStorage !== 'undefined' && hasRememberedPreloadConfirmation(localStorage);
		preloadPhase =
			!remembered && needsPreloadConfirmation(manifest.rounds.length, connectionInfo())
				? 'confirm'
				: 'start';
	});

	/**
	 * The start-quiz tap. Synchronous prefix is load-bearing — see module doc.
	 */
	function handleStartTap(): void {
		if (preloadPhase === 'confirm' && typeof localStorage !== 'undefined') {
			rememberPreloadConfirmation(localStorage);
		}
		const unlockPromise = audio.unlock(); // MUST be the first thing this handler does — see module doc.
		void runStart(unlockPromise);
	}

	async function runStart(unlockPromise: Promise<void>): Promise<void> {
		preloadPhase = 'loading';
		try {
			await unlockPromise;
		} catch (err) {
			sessionError =
				err instanceof Error
					? new ApiError(0, 'internal', err.message)
					: new ApiError(0, 'internal', 'Could not enable audio on this device.');
			return;
		}

		const rounds = manifest!.rounds;
		const result = await preloader.load(rounds, {
			onProgress: (p) => {
				preloadProgress = p;
			}
		});
		buffers = result.buffers;

		// MUS-5: a clip that failed to load makes its round skipped, same as a
		// round the server already knew had no preview.
		const skipped = new Set(result.skippedPositions);
		const patched: SessionManifest = {
			...manifest!,
			rounds: rounds.map((r: ManifestRound) => ({
				...r,
				skipped: r.skipped || skipped.has(r.position)
			}))
		};

		game = createGame(patched, ports);
		game.start();
	}

	// ---------------------------------------------------------------------------
	// GamePorts — the audio engine and the offline queue, wired to the machine.
	// ---------------------------------------------------------------------------

	let activeHandle: PlaybackHandle | null = null;
	let countdownValue = $state<number | null>(null);

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * A locally-timed 3-2-1 (ROUND-1). `game.phase` stays `'countdown'` until
	 * this resolves and the clip actually starts, because `beginRound()` in
	 * game-state.svelte.ts awaits `ports.playClip()` before flipping to
	 * `'clip'` — so delaying inside this port is what makes the countdown a
	 * real, visible phase without game-state needing to know about it.
	 */
	async function runCountdown(): Promise<void> {
		for (const tick of [3, 2, 1]) {
			countdownValue = tick;
			announcer.announce({ text: String(tick), politeness: 'assertive' });
			await delay(600);
		}
		countdownValue = null;
	}

	const ports: GamePorts = {
		now: () => audio.elapsedMs(),

		async playClip(position) {
			await runCountdown();
			const buffer = buffers.get(position);
			if (!buffer) {
				// Should be unreachable: game-state only calls playClip for
				// non-skipped rounds, and every non-skipped round has a buffer.
				throw new Error(`No decoded audio for round ${position}`);
			}
			activeHandle = audio.play(buffer, {
				onEnded: () => {
					activeHandle = null;
					announcer.clipEnded();
					announcer.announce({ text: 'Clip ended', politeness: 'assertive' });
					game?.notifyClipEnded();
				}
			});
			// clipMs must be the measured full buffer duration (§9's curve
			// denominator), not elapsed-at-lock — the server re-validates the
			// round's clipMs against the known preview duration at finalize.
			game?.reportClipDuration(audio.clipMs());
			announcer.clipStarted();
			announcer.announce({ text: 'Clip playing', politeness: 'assertive' });
		},

		stopClip() {
			activeHandle?.stop();
			activeHandle = null;
			// stop() never fires onEnded (ROUND-3 early end) — the clip-end
			// announcement has to happen from this same place instead.
			announcer.clipEnded();
			announcer.announce({ text: 'Clip ended', politeness: 'assertive' });
		},

		onRoundStart(position) {
			// Fire-and-forget (§4): never awaited, must never block gameplay.
			offlineQueue.enqueueRoundStart(manifest!.sessionId, position, audio.elapsedMs());
			void offlineQueue.flush();
		},

		onRoundResult(payload) {
			offlineQueue.enqueueRoundResult(manifest!.sessionId, payload);
			void offlineQueue.flush();
		},

		onComplete(results) {
			void finishSession(results);
		}
	};

	let game = $state<Game | null>(null);

	// ---------------------------------------------------------------------------
	// Finalize — never blocks the (already-rendered) summary phase.
	// ---------------------------------------------------------------------------

	let finalizePending = $state(false);
	let finalizeResult = $state<FinalizeResult | null>(null);
	let finalizeError = $state<ApiError | null>(null);

	async function finishSession(results: RoundResultPayload[]): Promise<void> {
		finalizePending = true;
		finalizeError = null;
		try {
			const result = await submitFinalize(manifest!.sessionId, { rounds: results });
			finalizeResult = result;
			recordPlay({
				sessionId: manifest!.sessionId,
				quizId: manifest!.quizId,
				score: result.totalScore,
				playedAt: Date.now()
			});
		} catch (err) {
			finalizeError =
				err instanceof ApiError ? err : new ApiError(0, 'network_error', 'Network error.');
		} finally {
			finalizePending = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Derived display helpers
	// ---------------------------------------------------------------------------

	function requiredTargets(): TargetName[] {
		if (!manifest) return [];
		return manifest.settings.guessTarget === 'both'
			? ['title', 'artist']
			: [manifest.settings.guessTarget];
	}

	function pointsFor(result: RoundResultPayload, target: TargetName): number {
		if (!manifest) return 0;
		const lockMs = result.lockTimes[target];
		if (lockMs === undefined) return 0;
		return getCurve(manifest.curveVersion).points(
			manifest.effectiveScoringMode,
			lockMs,
			result.clipMs
		);
	}

	function roundPoints(result: RoundResultPayload): number {
		return requiredTargets().reduce((sum, t) => sum + pointsFor(result, t), 0);
	}

	const runningTotal = $derived(
		game ? game.results.reduce((sum, r) => sum + roundPoints(r), 0) : 0
	);

	function handleAttempt(target: TargetName, accepted: boolean): void {
		const label = target === 'title' ? 'Title' : 'Artist';
		announcer.announce({
			text: accepted ? `${label} correct` : `${label} not that one`,
			politeness: 'assertive'
		});
	}

	// ---------------------------------------------------------------------------
	// Focus + announce on phase transitions (A11Y-2/3/6).
	// ---------------------------------------------------------------------------

	let phaseSectionEl = $state<HTMLElement | null>(null);

	$effect(() => {
		const phase = game?.phase ?? preloadPhase;
		void phase; // establish the dependency; the work below reads live values
		void tick().then(() => focusFirst(phaseSectionEl));
	});

	$effect(() => {
		if (!game) return;
		if (game.phase === 'reveal') {
			const pack = game.revealed;
			if (pack) {
				// Deferred defensively: by the time endRound() flips to 'reveal'
				// the clip has already stopped (see stopClip()/onEnded above), so
				// this normally fires immediately — but staying deferUntilGap keeps
				// it correct if that ordering ever changes.
				announcer.announce({
					text: `Reveal: ${pack.reveal.title} by ${pack.reveal.artists.join(', ')}`,
					politeness: 'polite',
					deferUntilGap: true
				});
			}
		} else if (game.phase === 'scoreboard') {
			announcer.announce({
				text: `Round ${game.roundIndex + 1} of ${game.totalRoundCount}. Score so far: ${runningTotal}.`,
				politeness: 'polite'
			});
		} else if (game.phase === 'summary') {
			announcer.announce({
				text: `Quiz complete. Score: ${runningTotal}.`,
				politeness: 'polite'
			});
		}
	});
</script>

<svelte:head>
	<title>Devinyl — Play</title>
</svelte:head>

<LiveRegion {announcer} />

{#if recoveredFinalize}
	<div class="banner" role="status">
		A previous game's score ({recoveredFinalize.totalScore} pts) was submitted.
		<button type="button" onclick={() => (recoveredFinalize = null)}>Dismiss</button>
	</div>
{/if}

<main>
	{#if !mounted}
		<p>Loading…</p>
	{:else if nickname === null}
		<section bind:this={phaseSectionEl} tabindex="-1">
			<h1>Pick a nickname to play</h1>
			<NicknamePrompt onsubmit={handleNicknameSubmit} />
		</section>
	{:else if sessionError}
		<section bind:this={phaseSectionEl} tabindex="-1">
			<h1>Couldn't start this quiz</h1>
			<p>{sessionError.message}</p>
			<button type="button" onclick={ensureSession}>Retry</button>
		</section>
	{:else if !manifest}
		<section bind:this={phaseSectionEl} tabindex="-1" aria-busy="true">
			<p>Preparing your quiz…</p>
		</section>
	{:else if !game}
		<PreloadGate
			phase={preloadPhase}
			roundCount={manifest.rounds.length}
			estimate={estimatePreload(manifest.rounds.length)}
			progress={preloadProgress}
			onStart={handleStartTap}
		/>
	{:else if game.phase === 'countdown'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="countdown">
			<h1>Round {game.roundIndex + 1} of {game.totalRoundCount}</h1>
			<p class="countdown-number" aria-hidden="true">{countdownValue ?? ''}</p>
		</section>
	{:else if game.phase === 'clip'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="clip">
			<h1>Round {game.roundIndex + 1} of {game.totalRoundCount}</h1>
			<p>Listen closely — the clip plays once.</p>
			{#if manifest.settings.answerMode === 'choice'}
				<ChoiceAnswer
					{game}
					required={requiredTargets()}
					choices={game.round?.choices ?? {}}
					sessionId={manifest.sessionId}
					position={game.round?.position ?? 0}
					onattempt={handleAttempt}
				/>
			{:else}
				<TextAnswer {game} required={requiredTargets()} onattempt={handleAttempt} />
			{/if}
		</section>
	{:else if game.phase === 'reveal'}
		{#if game.revealed}
			<RoundReveal
				pack={game.revealed}
				result={game.results[game.results.length - 1]}
				required={requiredTargets()}
				scoringMode={manifest.effectiveScoringMode}
				curveVersion={manifest.curveVersion}
				onNext={() => game?.advance()}
			/>
		{/if}
	{:else if game.phase === 'scoreboard'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="scoreboard">
			<h1>Score so far</h1>
			<p class="score-total">{runningTotal} pts</p>
			<p>Round {game.roundIndex + 1} of {game.totalRoundCount} complete.</p>
			<button type="button" onclick={() => game?.advance()}>Continue</button>
		</section>
	{:else if game.phase === 'summary'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="summary">
			<h1>Quiz complete</h1>

			{#if finalizePending}
				<p role="status">Submitting your score…</p>
			{:else if finalizeError}
				<p role="alert">
					Couldn't confirm your score with the server ({finalizeError.message}). Your local score is
					shown below; it will be retried automatically next visit.
				</p>
				<button type="button" onclick={() => finishSession(game!.results)}>Retry</button>
			{:else if finalizeResult}
				<p class="score-total">{finalizeResult.totalScore} pts</p>
				{#if !finalizeResult.scored}
					<p>This run isn't posted to a board ({finalizeResult.scoredBlockReason}).</p>
				{/if}
			{/if}

			{#if !finalizeResult}
				<p class="score-total">{runningTotal} pts (local, unconfirmed)</p>
			{/if}

			<ul class="round-breakdown">
				{#each game.results as result (result.position)}
					<li>
						Round {result.position + 1}: {result.skipped ? 'Skipped' : `${roundPoints(result)} pts`}
					</li>
				{/each}
			</ul>

			<!-- Challenge/share are Phase 3 (CHAL-1…4) — stubbed here on purpose. -->
			<button type="button" disabled title="Coming soon">Challenge a friend</button>

			<a href={resolve('/')}>Play again</a>
		</section>
	{:else if game.phase === 'abandoned'}
		<section bind:this={phaseSectionEl} tabindex="-1">
			<h1>This session was abandoned</h1>
			<a href={resolve('/')}>Start a new quiz</a>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 30rem;
		margin: 0 auto;
		padding: 1.5rem;
	}

	main :global(section) {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	main :global(section:focus) {
		outline: none;
	}

	.banner {
		display: flex;
		gap: 1rem;
		align-items: center;
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid;
	}

	.countdown-number {
		font-size: 3rem;
		font-weight: 700;
		text-align: center;
	}

	.score-total {
		font-size: 1.5rem;
		font-weight: 700;
	}

	.round-breakdown {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	button {
		align-self: flex-start;
		padding: 0.6rem 1.25rem;
		font-size: 1rem;
		cursor: pointer;
	}

	@media (prefers-reduced-motion: reduce) {
		.countdown-number {
			transition: none;
		}
	}
</style>
