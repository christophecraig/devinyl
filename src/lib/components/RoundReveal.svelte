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
	<h2 class="eyebrow-heading">Reveal</h2>

	{#if result.skipped}
		<p class="skipped-note">This clip couldn't be played — the round was skipped, not scored.</p>
	{/if}

	<div class="reveal-card">
		{#if pack.reveal.coverUrl}
			<!-- The disc peeking out from behind the sleeve is a sibling, not a
			     pseudo-element: `img` can't carry `::after`, and the alternative
			     (a wrapper with a background-image) would lose the intrinsic
			     width/height that keeps this card from shifting layout on load. -->
			<div class="sleeve">
				<span class="disc" aria-hidden="true"></span>
				<img
					class="cover"
					src={pack.reveal.coverUrl}
					alt={`Cover art for ${pack.reveal.title}`}
					width="120"
					height="120"
				/>
			</div>
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

	<button class="primary next" type="button" onclick={onNext}>Next</button>
</section>

<style>
	.round-reveal {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 28rem;
		animation: rise var(--dur-slow) var(--ease) both;
	}

	.round-reveal:focus {
		outline: none;
	}

	/* An <h2> for the outline (and the e2e's `heading, name: "Reveal"`), sized
	   as a label: the track title below is the real headline of this screen. */
	.eyebrow-heading {
		font-family: var(--font-body);
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.reveal-card {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		padding: var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lift);
	}

	.sleeve {
		position: relative;
		flex: none;
		line-height: 0;
		/* Clearance for the disc's protruding half, so it never lands on top of
		   the track title next to it. */
		margin-right: var(--space-6);
	}

	.cover {
		position: relative;
		border-radius: var(--radius-sm);
		object-fit: cover;
		box-shadow: var(--shadow-card);
	}

	/* Half a record sliding out of the right edge of the sleeve. */
	.disc {
		position: absolute;
		top: 50%;
		right: 0;
		width: 96px;
		height: 96px;
		border-radius: var(--radius-pill);
		transform: translate(0, -50%);
		background:
			radial-gradient(circle, var(--surface-raised) 0 7%, transparent 7%),
			radial-gradient(circle, var(--accent) 7% 30%, transparent 30%),
			repeating-radial-gradient(
				circle,
				var(--ink) 30% 33%,
				color-mix(in srgb, var(--ink) 65%, var(--surface)) 33% 38%
			);
		animation: slide-out var(--dur-slow) var(--ease) 120ms both;
	}

	@keyframes slide-out {
		from {
			transform: translate(-40%, -50%);
		}
		to {
			transform: translate(36%, -50%);
		}
	}

	.meta {
		min-width: 0;
	}

	.title {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: var(--text-title);
		line-height: 1.2;
		margin: 0;
		text-wrap: balance;
	}

	.artists {
		margin: var(--space-1) 0 0;
		color: var(--accent-ink);
		font-weight: 600;
	}

	.album {
		margin: var(--space-1) 0 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	.outcomes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.outcomes li {
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm);
		border-left: 3px solid var(--rule-strong);
		font-size: var(--text-small);
		font-weight: 600;
		background: var(--surface-sunken);
	}

	.outcomes .correct {
		color: var(--positive);
		border-left-color: var(--positive);
		background: var(--positive-soft);
	}

	.outcomes .missed {
		color: var(--ink-muted);
	}

	.skipped-note {
		margin: 0;
		padding: var(--space-3);
		font-size: var(--text-small);
		background: var(--accent-soft);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-sm);
	}

	.next {
		align-self: stretch;
	}

	@media (prefers-reduced-motion: reduce) {
		/* The disc's whole point is the slide; without motion it just sits in
		   its final resting position rather than animating there. */
		.disc {
			transform: translate(36%, -50%);
		}
	}
</style>
