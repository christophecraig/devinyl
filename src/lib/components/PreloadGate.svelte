<script lang="ts">
	/**
	 * Pre-game gate — technical-spec §4 performance-budget table, MUS-7, task 1.28.
	 *
	 * Three presentational states driven entirely by the `phase` prop; this
	 * component owns no network/audio logic itself (that lives in the play
	 * route, which is where `AudioEngine.unlock()` must be called — see the
	 * route's module doc). Keeping this dumb means the one call that has to be
	 * synchronous-inside-a-gesture-handler (`unlock()`) stays visibly next to
	 * the route's other session/ports wiring instead of hiding inside a child
	 * component's click handler.
	 *
	 * - `start`: no confirmation required (≤ `PRELOAD_CONFIRM_THRESHOLD` rounds,
	 *   fast connection, already remembered) — a single CTA.
	 * - `confirm`: MUS-7's explicit gate — above the round threshold, or a
	 *   `Save-Data`/slow connection — shows the estimated size/time and requires
	 *   an explicit tap before any bytes move.
	 * - `loading`: `Preloader.load()` is running; a live progress readout.
	 *
	 * `onStart` fires for both `start` and `confirm` — it is the same tap
	 * either way, just gated behind an extra screen of context in the `confirm`
	 * case. The route synchronously calls `AudioEngine.unlock()` as the very
	 * first statement inside that handler (iOS Safari autoplay policy).
	 */
	import type { PreloadEstimate, PreloadProgress } from '$lib/client/preloader.js';

	interface Props {
		phase: 'start' | 'confirm' | 'loading';
		roundCount: number;
		estimate: PreloadEstimate;
		progress: PreloadProgress | null;
		onStart: () => void;
		/** A11Y-5/§9: true when this session resolved to the fixed-scoring (untimed) board — told here, before the player commits to playing. */
		untimedBoard?: boolean;
	}

	let { phase, roundCount, estimate, progress, onStart, untimedBoard = false }: Props = $props();

	function formatMb(bytes: number): string {
		return (bytes / (1024 * 1024)).toFixed(1);
	}

	function formatSeconds(seconds: number): string {
		return Math.max(1, Math.round(seconds)).toString();
	}

	const skippedCount = $derived(
		progress ? progress.clips.filter((c) => c.status === 'skipped').length : 0
	);
</script>

<!-- tabindex="-1": this section is the deliberate focus target when nothing
     inside it is focusable yet (A11Y-3), e.g. the bare loading state. -->
<section class="preload-gate" tabindex="-1">
	{#if phase === 'loading'}
		<p class="eyebrow">Cueing up</p>
		<h1>Loading your quiz…</h1>
		<div
			class="progress-track"
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={progress?.total ?? roundCount}
			aria-valuenow={progress?.settled ?? 0}
		>
			<div class="progress-fill" style:width={`${(progress?.fraction ?? 0) * 100}%`}></div>
		</div>
		<!-- polite status readout — not part of the gameplay Announcer, this is
		     a one-off loading screen, not a round-flow announcement. -->
		<p class="status" role="status" aria-live="polite">
			Loaded {progress?.settled ?? 0} of {progress?.total ?? roundCount} clips
			{#if skippedCount > 0}
				&mdash; {skippedCount} unavailable and will be skipped
			{/if}
		</p>
	{:else}
		<p class="eyebrow">{roundCount} rounds</p>
		<h1>Ready to play?</h1>

		<!-- The house rules, as a list rather than a sentence: it is the last
		     thing a player reads before the clock starts, and MUS-7's "clips
		     play once" is the expectation most worth landing. -->
		<ul class="rules">
			<li>Each clip plays <strong>once</strong> — no pausing, no replays.</li>
			<li>Answer faster, score higher.</li>
			<li>Wrong guesses cost you nothing but time.</li>
		</ul>

		{#if untimedBoard}
			<p class="notice">
				You're playing on the <strong>untimed board</strong> — speed doesn't affect your score, only
				getting the answer right.
			</p>
		{/if}
		{#if phase === 'confirm'}
			<p class="notice">
				This quiz is large or your connection looks slow: about {formatMb(estimate.bytes)} MB, roughly
				{formatSeconds(estimate.seconds)} s to download.
			</p>
		{/if}
		<button class="primary start" type="button" onclick={onStart}>
			{phase === 'confirm' ? 'Download and start' : 'Start quiz'}
		</button>
	{/if}
</section>

<style>
	.preload-gate {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 28rem;
		animation: rise var(--dur-slow) var(--ease) both;
	}

	.preload-gate:focus {
		outline: none;
	}

	h1 {
		font-size: var(--text-hero);
	}

	.rules {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		color: var(--ink-muted);
	}

	.rules li {
		position: relative;
		padding-left: var(--space-5);
	}

	/* Each rule gets its own little stylus dot — the same ornament as `.rule`. */
	.rules li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.6em;
		width: 5px;
		height: 5px;
		border-radius: var(--radius-pill);
		background: var(--accent);
	}

	.rules strong {
		color: var(--ink);
	}

	.notice {
		margin: 0;
		padding: var(--space-3);
		font-size: var(--text-small);
		background: var(--accent-soft);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-sm);
	}

	.start {
		align-self: stretch;
		font-size: var(--text-title);
		padding-block: var(--space-4);
	}

	.progress-track {
		height: 0.6rem;
		background: var(--surface-sunken);
		border: 1px solid var(--rule);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent);
		transition: width var(--dur) var(--ease);
	}

	.status {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	@media (prefers-reduced-motion: reduce) {
		.progress-fill {
			transition: none;
		}
	}
</style>
