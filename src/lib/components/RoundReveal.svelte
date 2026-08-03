<script lang="ts">
	/**
	 * Round reveal — technical-spec ROUND-4/5/6, §9, task 1.28.
	 *
	 * Shows what `game.revealed` only exposes once the round is actually over
	 * (ROUND-4 — see game-state.svelte.ts's module doc on why the pack stays
	 * private until then), this round's outcome, and a manual "Next" button.
	 * ROUND-6: advancing is **never** automatic — the route wires `onNext` to
	 * `game.advance()` and nothing else calls it.
	 *
	 * Points shown here are a client-side preview computed with the same
	 * versioned curve the server uses (§9) — useful immediate feedback, but
	 * not authoritative; `finalize` recomputes from raw `lockTimes` server-side
	 * (§7.3) and that response is what the summary screen ultimately trusts.
	 */
	import type { RoundPack, RoundResultPayload, ScoringMode, TargetName } from '$lib/game/types.js';
	import { getCurve } from '$lib/game/scoring.js';

	interface Props {
		pack: RoundPack;
		result: RoundResultPayload;
		required: TargetName[];
		scoringMode: ScoringMode;
		curveVersion: number;
		onNext: () => void;
	}

	let { pack, result, required, scoringMode, curveVersion, onNext }: Props = $props();

	const TARGET_LABEL: Record<TargetName, string> = { title: 'Title', artist: 'Artist' };

	interface TargetOutcome {
		target: TargetName;
		locked: boolean;
		points: number;
	}

	const outcomes = $derived<TargetOutcome[]>(
		required.map((target) => {
			const lockMs = result.lockTimes[target];
			const locked = lockMs !== undefined;
			const curve = getCurve(curveVersion);
			return {
				target,
				locked,
				points: locked ? curve.points(scoringMode, lockMs, result.clipMs) : 0
			};
		})
	);
</script>

<section class="round-reveal" tabindex="-1">
	<h2>Reveal</h2>

	{#if result.skipped}
		<p class="skipped-note">This clip couldn't be played — the round was skipped, not scored.</p>
	{/if}

	<div class="reveal-card">
		{#if pack.reveal.coverUrl}
			<img
				class="cover"
				src={pack.reveal.coverUrl}
				alt={`Cover art for ${pack.reveal.title}`}
				width="120"
				height="120"
			/>
		{/if}
		<div class="meta">
			<p class="title">{pack.reveal.title}</p>
			<p class="artists">{pack.reveal.artists.join(', ')}</p>
			<p class="album">
				{pack.reveal.albumTitle}
				{#if pack.reveal.releaseYear}
					&middot; {pack.reveal.releaseYear}
				{/if}
			</p>
		</div>
	</div>

	{#if !result.skipped}
		<ul class="outcomes">
			{#each outcomes as outcome (outcome.target)}
				<li class:correct={outcome.locked} class:missed={!outcome.locked}>
					{TARGET_LABEL[outcome.target]}: {outcome.locked
						? `correct, +${outcome.points} pts`
						: 'not answered'}
				</li>
			{/each}
		</ul>
	{/if}

	<button type="button" onclick={onNext}>Next</button>
</section>

<style>
	.round-reveal {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 28rem;
	}

	.round-reveal:focus {
		outline: none;
	}

	.reveal-card {
		display: flex;
		gap: 1rem;
		align-items: center;
	}

	.cover {
		border-radius: 0.25rem;
		object-fit: cover;
	}

	.title {
		font-weight: 700;
		font-size: 1.1rem;
		margin: 0;
	}

	.artists,
	.album {
		margin: 0.15rem 0 0;
	}

	.outcomes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.outcomes .correct {
		color: #1e8449;
	}

	.outcomes .missed {
		opacity: 0.75;
	}

	.skipped-note {
		font-style: italic;
	}

	button {
		align-self: flex-start;
		padding: 0.6rem 1.25rem;
		font-size: 1rem;
		cursor: pointer;
	}
</style>
