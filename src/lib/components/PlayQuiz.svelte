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
	import { onMount, tick, type Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import LiveRegion from '$lib/components/LiveRegion.svelte';
	import NicknamePrompt from '$lib/components/NicknamePrompt.svelte';
	import PreloadGate from '$lib/components/PreloadGate.svelte';
	import RoundReveal from '$lib/components/RoundReveal.svelte';
	import TextAnswer from '$lib/components/TextAnswer.svelte';
	import ChoiceAnswer from '$lib/components/ChoiceAnswer.svelte';
	import ChallengeShare from '$lib/components/ChallengeShare.svelte';
	import DailyShare from '$lib/components/DailyShare.svelte';
	import BoardPreview from '$lib/components/BoardPreview.svelte';
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
	import { createSession, ApiError, type BoardScopePath } from '$lib/client/api.js';
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
	import { m } from '$lib/paraglide/messages.js';
	import { localizeApiErrorCode } from '$lib/client/errors.js';

	/**
	 * What's being played, mirroring `CreateSessionBody`'s "exactly one of
	 * these" shape (`$lib/game/schemas.ts`) — the caller route already knows
	 * which, so this component never re-derives it from a URL.
	 */
	export type PlayTarget =
		{ quizId: string } | { challengeToken: string } | { daily: true; day?: string };

	interface Props {
		target: PlayTarget;
		/** CHAL-1 lobby banner ("X challenged you — NNN pts to beat") shown above the nickname prompt. */
		banner?: Snippet;
		/** DAILY-3: the day number for the share text — only meaningful when `target.daily`. */
		dailyDayNumber?: number;
	}

	const { target, banner, dailyDayNumber }: Props = $props();

	function boardScope(): BoardScopePath {
		if ('quizId' in target) return { kind: 'quiz', quizId: target.quizId };
		if ('challengeToken' in target) return { kind: 'challenge', token: target.challengeToken };
		return { kind: 'daily', day: target.day };
	}

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
		createSession({ ...target, nickname: nickname ?? undefined })
			.then((m) => {
				manifest = m;
			})
			.catch((err: unknown) => {
				sessionError =
					err instanceof ApiError ? err : new ApiError(0, 'network_error', m.home_error_network());
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
					: new ApiError(0, 'internal', m.play_audio_unlock_failed());
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

	// ---------------------------------------------------------------------------
	// Clip timer — visual-only feedback for the decaying speed-scoring curve
	// (SCORE-2). Polls the audio clock via rAF rather than a live region: it
	// changes every frame, so announcing it would spam screen readers. The
	// existing clip-start/clip-end announcements already cover that audience.
	// ---------------------------------------------------------------------------

	let clipProgress = $state(0);
	let clipRemainingMs = $state(0);
	let clipTimerFrame: number | null = null;

	function tickClipTimer(): void {
		if (game?.phase !== 'clip') {
			clipTimerFrame = null;
			return;
		}
		const total = audio.clipMs();
		const elapsed = audio.elapsedMs();
		clipProgress = total > 0 ? Math.min(1, elapsed / total) : 0;
		clipRemainingMs = Math.max(0, total - elapsed);
		clipTimerFrame = requestAnimationFrame(tickClipTimer);
	}

	$effect(() => {
		if (game?.phase === 'clip' && clipTimerFrame === null) {
			clipTimerFrame = requestAnimationFrame(tickClipTimer);
		}
		return () => {
			if (clipTimerFrame !== null) {
				cancelAnimationFrame(clipTimerFrame);
				clipTimerFrame = null;
			}
		};
	});

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
		for (const tickValue of [3, 2, 1]) {
			countdownValue = tickValue;
			announcer.announce({ text: String(tickValue), politeness: 'assertive' });
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
					announcer.announce({ text: m.announce_clip_ended(), politeness: 'assertive' });
					game?.notifyClipEnded();
				}
			});
			// clipMs must be the measured full buffer duration (§9's curve
			// denominator), not elapsed-at-lock — the server re-validates the
			// round's clipMs against the known preview duration at finalize.
			game?.reportClipDuration(audio.clipMs());
			announcer.clipStarted();
			announcer.announce({ text: m.announce_clip_playing(), politeness: 'assertive' });
		},

		stopClip() {
			activeHandle?.stop();
			activeHandle = null;
			// stop() never fires onEnded (ROUND-3 early end) — the clip-end
			// announcement has to happen from this same place instead.
			announcer.clipEnded();
			announcer.announce({ text: m.announce_clip_ended(), politeness: 'assertive' });
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
				err instanceof ApiError ? err : new ApiError(0, 'network_error', m.home_error_network());
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
		const label = target === 'title' ? m.common_label_title() : m.common_label_artist();
		announcer.announce({
			text: accepted
				? m.announce_attempt_correct({ label })
				: m.announce_attempt_incorrect({ label }),
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
					text: m.announce_reveal({
						title: pack.reveal.title,
						artists: pack.reveal.artists.join(', ')
					}),
					politeness: 'polite',
					deferUntilGap: true
				});
			}
		} else if (game.phase === 'scoreboard') {
			announcer.announce({
				text: m.announce_scoreboard({
					index: game.roundIndex + 1,
					total: game.totalRoundCount,
					score: runningTotal
				}),
				politeness: 'polite'
			});
		} else if (game.phase === 'summary') {
			announcer.announce({
				text: m.announce_summary({ score: runningTotal }),
				politeness: 'polite'
			});
		}
	});
</script>

<LiveRegion {announcer} />

<!--
	Round progress, as filled/unfilled pips. `aria-hidden` throughout: the `<h1>`
	directly above it already says "Round 3 of 10" in words, so exposing this
	would just make every phase change announce the same fact twice.
-->
{#snippet roundPips(index: number, total: number)}
	<div class="pips" aria-hidden="true">
		{#each { length: total }, i}
			<span class="pip" class:done={i < index} class:current={i === index}></span>
		{/each}
	</div>
{/snippet}

{#if recoveredFinalize}
	<div class="banner" role="status">
		<p>{m.play_recovered_banner({ score: recoveredFinalize.totalScore })}</p>
		<button class="quiet" type="button" onclick={() => (recoveredFinalize = null)}
			>{m.common_dismiss()}</button
		>
	</div>
{/if}

<main class="sheet">
	{#if banner && !game}
		{@render banner()}
	{/if}
	{#if !mounted}
		<p class="waiting">{m.common_loading()}</p>
	{:else if nickname === null}
		<section bind:this={phaseSectionEl} tabindex="-1">
			<h1>{m.home_nickname_heading()}</h1>
			<NicknamePrompt onsubmit={handleNicknameSubmit} />
		</section>
	{:else if sessionError}
		<section bind:this={phaseSectionEl} tabindex="-1">
			<h1>{m.play_session_error_heading()}</h1>
			<p class="error-note">{localizeApiErrorCode(sessionError.code)}</p>
			<button type="button" onclick={ensureSession}>{m.common_retry()}</button>
		</section>
	{:else if !manifest}
		<section bind:this={phaseSectionEl} tabindex="-1" aria-busy="true">
			<p class="waiting">{m.play_preparing()}</p>
		</section>
	{:else if !game}
		<PreloadGate
			phase={preloadPhase}
			roundCount={manifest.rounds.length}
			estimate={estimatePreload(manifest.rounds.length)}
			progress={preloadProgress}
			onStart={handleStartTap}
			untimedBoard={manifest.effectiveScoringMode === 'fixed'}
		/>
	{:else if game.phase === 'countdown'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="countdown">
			<h1 class="round-heading">
				{m.play_round_heading({ index: game.roundIndex + 1, total: game.totalRoundCount })}
			</h1>
			{@render roundPips(game.roundIndex, game.totalRoundCount)}
			<!-- Keyed so each tick re-mounts the number and re-runs its entrance;
			     a plain text swap would animate once and then sit still. -->
			{#key countdownValue}
				<p class="countdown-number" aria-hidden="true">{countdownValue ?? ''}</p>
			{/key}
			<p class="countdown-note" aria-hidden="true">{m.play_countdown_ready()}</p>
		</section>
	{:else if game.phase === 'clip'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="clip">
			<h1 class="round-heading">
				{m.play_round_heading({ index: game.roundIndex + 1, total: game.totalRoundCount })}
			</h1>
			{@render roundPips(game.roundIndex, game.totalRoundCount)}
			<p class="clip-note">{m.play_clip_note()}</p>
			<div class="clip-timer" class:urgent={clipRemainingMs > 0 && clipRemainingMs < 5000}>
				<div class="clip-timer-track" aria-hidden="true">
					<div class="clip-timer-fill" style={`width: ${(clipProgress * 100).toFixed(2)}%`}></div>
					<span class="clip-timer-knob" style={`left: ${(clipProgress * 100).toFixed(2)}%`}></span>
				</div>
				<!-- aria-hidden, not a live region: this repaints every frame, and
				     the clip start/end announcements already carry this for screen
				     readers (see the clip-timer note in the script above). -->
				<span class="clip-timer-label" aria-hidden="true"
					>{m.play_clip_seconds_left({ seconds: Math.ceil(clipRemainingMs / 1000) })}</span
				>
			</div>
			{#if manifest.settings.answerMode === 'choice'}
				<ChoiceAnswer
					{game}
					required={requiredTargets()}
					choices={game.round?.choices ?? {}}
					sessionId={manifest.sessionId}
					position={game.round?.position ?? 0}
					retryMode={manifest.settings.choiceRetryMode}
					penaltySeconds={manifest.settings.choiceRetryPenaltySeconds}
					onattempt={handleAttempt}
				/>
			{:else}
				<TextAnswer {game} required={requiredTargets()} onattempt={handleAttempt} />
			{/if}
		</section>
	{:else if game.phase === 'reveal'}
		<!--
			A11Y-3: every phase gets its own `bind:this` target. Without one here the
			phase `$effect` would call `focusFirst` on the *previous* phase's now-detached
			section and quietly move focus nowhere — the reveal is the one transition a
			screen-reader user most needs to land on, and it would have been the only
			phase that skipped it. The wrapper sits outside the `{#if}` so the binding
			exists even in the (unreachable) case where the pack failed to open.
		-->
		<section bind:this={phaseSectionEl} tabindex="-1">
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
		</section>
	{:else if game.phase === 'scoreboard'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="scoreboard">
			<h1 class="round-heading">{m.play_scoreboard_heading()}</h1>
			<p class="score-total">{m.play_score_pts({ score: runningTotal })}</p>
			{@render roundPips(game.roundIndex + 1, game.totalRoundCount)}
			<p class="muted">
				{m.play_round_complete({ index: game.roundIndex + 1, total: game.totalRoundCount })}
			</p>
			<button class="primary wide" type="button" onclick={() => game?.advance()}
				>{m.common_continue()}</button
			>
		</section>
	{:else if game.phase === 'summary'}
		<section bind:this={phaseSectionEl} tabindex="-1" class="summary">
			<p class="eyebrow">{m.play_summary_eyebrow()}</p>
			<h1>{m.play_summary_heading()}</h1>

			{#if finalizePending}
				<p class="waiting" role="status">{m.play_submitting()}</p>
			{:else if finalizeError}
				<p class="error-note" role="alert">
					{m.play_finalize_error({ message: localizeApiErrorCode(finalizeError.code) })}
				</p>
				<button type="button" onclick={() => finishSession(game!.results)}
					>{m.common_retry()}</button
				>
			{:else if finalizeResult}
				<p class="score-total final">{m.play_score_pts({ score: finalizeResult.totalScore })}</p>
				{#if !finalizeResult.scored}
					<p class="muted">
						{m.play_not_on_board({ reason: finalizeResult.scoredBlockReason ?? '' })}
					</p>
				{/if}
			{/if}

			{#if !finalizeResult}
				<p class="score-total final">{m.play_score_local({ score: runningTotal })}</p>
			{/if}

			<hr class="rule" />

			<ul class="round-breakdown">
				{#each game.results as result (result.position)}
					<li class:skipped={result.skipped}>
						<span>{m.play_round_label({ index: result.position + 1 })}</span>
						<span class="breakdown-points"
							>{result.skipped
								? m.play_round_skipped()
								: m.play_score_pts({ score: roundPoints(result) })}</span
						>
					</li>
				{/each}
			</ul>

			{#if finalizeResult}
				<BoardPreview scope={boardScope()} mode={manifest.effectiveScoringMode} />
			{/if}

			<div class="summary-actions">
				{#if finalizeResult}
					<ChallengeShare
						sessionId={finalizeResult.sessionId}
						nickname={nickname ?? m.play_default_friend_nickname()}
						scoreToBeat={finalizeResult.totalScore}
					/>
					{#if 'daily' in target && dailyDayNumber !== undefined}
						<DailyShare
							dayNumber={dailyDayNumber}
							totalScore={finalizeResult.totalScore}
							rounds={finalizeResult.rounds}
						/>
					{/if}
				{/if}

				<a class="btn" href={resolve('/')}>{m.play_play_again()}</a>
			</div>
		</section>
	{:else if game.phase === 'abandoned'}
		<section bind:this={phaseSectionEl} tabindex="-1">
			<h1>{m.play_abandoned_heading()}</h1>
			<a class="btn" href={resolve('/')}>{m.play_start_new()}</a>
		</section>
	{/if}
</main>

<style>
	main :global(section) {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	main :global(section:focus) {
		outline: none;
	}

	/* Sections are stretch-aligned flex columns (the answer UIs and timers all
	   want the full column), so a standalone button would otherwise run edge to
	   edge. Opt back in per-button with `.wide` where full width is the point. */
	main :global(section > button) {
		align-self: flex-start;
	}

	.banner {
		display: flex;
		gap: var(--space-4);
		align-items: center;
		justify-content: space-between;
		padding: var(--space-3) var(--space-4);
		background: var(--accent-soft);
		border-bottom: 1px solid var(--accent);
		font-size: var(--text-small);
	}

	.banner p {
		margin: 0;
	}

	.waiting {
		color: var(--ink-muted);
	}

	.error-note {
		margin: 0;
		padding: var(--space-3);
		background: var(--negative-soft);
		border-left: 3px solid var(--negative);
		border-radius: var(--radius-sm);
	}

	/* The phase heading is a wayfinding label, not the loudest thing on screen
	   — the countdown digit and the answer inputs are. */
	.round-heading {
		font-family: var(--font-body);
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.pips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		width: 100%;
		max-width: 22rem;
	}

	.pip {
		max-width: 1.75rem;
		flex: 1 1 0.5rem;
		height: 4px;
		border-radius: var(--radius-pill);
		background: var(--surface-sunken);
		border: 1px solid var(--rule);
	}

	.pip.done {
		background: var(--accent);
		border-color: var(--accent);
	}

	.pip.current {
		background: var(--accent-soft);
		border-color: var(--accent);
	}

	/* --- Countdown ---------------------------------------------------------- */

	.countdown {
		align-items: center;
		text-align: center;
		padding-top: var(--space-6);
	}

	.countdown-number {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(5rem, 4rem + 14vw, 9rem);
		font-weight: 600;
		line-height: 1;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
		animation: stamp var(--dur-slow) var(--ease) both;
	}

	.countdown-note {
		margin: 0;
		font-size: var(--text-micro);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--ink-faint);
	}

	/* --- Clip --------------------------------------------------------------- */

	.clip-note {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	.clip-timer {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
	}

	/* The groove: a hairline the stylus travels along, rather than a bar that
	   fills. Overflow stays visible so the knob can sit proud of the track. */
	.clip-timer-track {
		position: relative;
		flex: 1;
		height: 3px;
		border-radius: var(--radius-pill);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--rule);
	}

	.clip-timer-fill {
		height: 100%;
		border-radius: var(--radius-pill);
		background: var(--accent);
		transition: width 0.1s linear;
	}

	.clip-timer-knob {
		position: absolute;
		top: 50%;
		width: 11px;
		height: 11px;
		border-radius: var(--radius-pill);
		background: var(--accent);
		border: 2px solid var(--surface-raised);
		transform: translate(-50%, -50%);
		transition: left 0.1s linear;
	}

	.clip-timer-label {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		font-size: var(--text-title);
		min-width: 4.5rem;
		text-align: right;
		color: var(--ink-muted);
	}

	/* Last five seconds. Colour *and* a pulse — colour alone would be the only
	   signal for a change that matters to scoring. */
	.clip-timer.urgent .clip-timer-label {
		color: var(--accent-ink);
	}

	.clip-timer.urgent .clip-timer-knob {
		animation: pulse 900ms var(--ease) infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
		}
		50% {
			box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 0%, transparent);
		}
	}

	/* --- Scoreboard + summary ------------------------------------------------ */

	.score-total {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--text-hero);
		font-weight: 600;
		line-height: 1;
		color: var(--accent-ink);
		font-variant-numeric: tabular-nums;
		animation: stamp var(--dur-slow) var(--ease) both;
		/* Left-aligned text in a full-width block: scale from the text's own
		   edge so the number grows in place instead of drifting right. */
		transform-origin: left center;
	}

	.score-total.final {
		font-size: clamp(3rem, 2.2rem + 4vw, 4.5rem);
	}

	.summary .eyebrow + h1 {
		font-size: var(--text-display);
	}

	.round-breakdown {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.round-breakdown li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--rule);
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}

	.round-breakdown li.skipped {
		color: var(--ink-muted);
	}

	.breakdown-points {
		font-weight: 600;
	}

	.summary-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: var(--space-2);
	}

	.wide {
		align-self: stretch;
	}

	@media (prefers-reduced-motion: reduce) {
		.clip-timer-fill,
		.clip-timer-knob {
			transition: none;
		}

		.clip-timer.urgent .clip-timer-knob {
			animation: none;
			/* The pulse is the urgency cue; without it, hold the largest ring so
			   the signal survives rather than disappearing entirely. */
			box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 35%, transparent);
		}
	}
</style>
