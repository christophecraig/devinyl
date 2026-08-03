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
	}

	let { phase, roundCount, estimate, progress, onStart }: Props = $props();

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
		<p role="status" aria-live="polite">
			Loaded {progress?.settled ?? 0} of {progress?.total ?? roundCount} clips
			{#if skippedCount > 0}
				&mdash; {skippedCount} unavailable and will be skipped
			{/if}
		</p>
	{:else}
		<h1>Ready to play?</h1>
		<p>{roundCount} rounds. Once you start, clips play once each — no pausing or replaying.</p>
		{#if phase === 'confirm'}
			<p>
				This quiz is large or your connection looks slow: about {formatMb(estimate.bytes)} MB, roughly
				{formatSeconds(estimate.seconds)} s to download.
			</p>
		{/if}
		<button type="button" onclick={onStart}>
			{phase === 'confirm' ? 'Download and start' : 'Start quiz'}
		</button>
	{/if}
</section>

<style>
	.preload-gate {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 28rem;
	}

	.preload-gate:focus {
		outline: none;
	}

	button {
		align-self: flex-start;
		padding: 0.75rem 1.5rem;
		font-size: 1rem;
		cursor: pointer;
	}

	.progress-track {
		height: 0.75rem;
		border: 1px solid;
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: currentColor;
		transition: width 0.2s ease;
	}

	@media (prefers-reduced-motion: reduce) {
		.progress-fill {
			transition: none;
		}
	}
</style>
