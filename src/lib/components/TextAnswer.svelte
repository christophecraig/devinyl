<script lang="ts">
	/**
	 * Free-text answer inputs — technical-spec §7.2, task 1.24.
	 *
	 * Two independent inputs, one per required target (ANS-1): locking one
	 * never touches the other's input or lock state, since each target tracks
	 * its own rejected/locked flag off `game.lockedTargets` rather than any
	 * shared "current attempt" state.
	 *
	 * Accept/reject is read back from `game.lockedTargets` rather than trusted
	 * from a return value — `submitGuess()` returns void and logs every
	 * attempt itself (game-state.svelte.ts), so this is the only signal this
	 * component has for what happened, and it is also the correct one: the
	 * game machine is the single source of truth for "locked".
	 *
	 * ANS-5 (zero leakage): on reject we set a local `rejected` flag and
	 * render a plain "not that one" status — never any part of the guess, the
	 * pack, or a hint. The input's value is left untouched (not cleared) so
	 * retrying costs nothing (ANS-4 free retries) and the player can just
	 * keep typing.
	 */
	import type { Game } from '$lib/client/game-state.svelte.js';
	import type { TargetName } from '$lib/game/types.js';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		game: Game;
		required: TargetName[];
		/** Fires on every submit so the page can announce it (A11Y-2). */
		onattempt?: (target: TargetName, accepted: boolean) => void;
	}

	let { game, required, onattempt }: Props = $props();

	const LABEL: Record<TargetName, string> = {
		title: m.common_label_title(),
		artist: m.common_label_artist()
	};

	/** Local per-target draft text; not derived from `game` so a locked target's last value stays visible. */
	let drafts = $state<Partial<Record<TargetName, string>>>({});
	/** Set right after a rejected submit, cleared on the next submit of that target — drives the "not that one" status only, never the guess itself (ANS-5). */
	let rejected = $state<Partial<Record<TargetName, boolean>>>({});

	let inputEls: Partial<Record<TargetName, HTMLInputElement>> = {};

	function isLocked(target: TargetName): boolean {
		return game.lockedTargets.includes(target);
	}

	function nextUnlockedAfter(target: TargetName): TargetName | null {
		const idx = required.indexOf(target);
		for (let i = idx + 1; i < required.length; i++) {
			if (!isLocked(required[i])) return required[i];
		}
		for (let i = 0; i < idx; i++) {
			if (!isLocked(required[i])) return required[i];
		}
		return null;
	}

	function submit(target: TargetName): void {
		if (isLocked(target)) return; // already locked: cannot be resubmitted
		const raw = drafts[target] ?? '';
		if (raw.trim() === '') return; // empty/whitespace is a no-op, never enters the guess log

		game.submitGuess(target, raw);
		const accepted = isLocked(target);
		onattempt?.(target, accepted);

		if (accepted) {
			rejected = { ...rejected, [target]: false };
			const next = nextUnlockedAfter(target);
			if (next) inputEls[next]?.focus(); // A11Y-6: deliberate focus move on accept
			// else: focus stays put — nothing left to move to.
		} else {
			rejected = { ...rejected, [target]: true }; // reject: focus stays put so the player can retype immediately
		}
	}

	function handleKeydown(event: KeyboardEvent, target: TargetName): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			submit(target);
		}
	}
</script>

<div class="text-answer">
	{#each required as target (target)}
		{@const locked = isLocked(target)}
		{@const isRejected = !locked && (rejected[target] ?? false)}
		{@const statusId = `text-answer-status-${target}`}
		<div class="field" class:is-locked={locked}>
			<label for={`text-answer-input-${target}`}>{LABEL[target]}</label>
			<input
				id={`text-answer-input-${target}`}
				bind:this={inputEls[target]}
				type="text"
				autocomplete="off"
				disabled={locked}
				bind:value={drafts[target]}
				aria-invalid={isRejected ? 'true' : 'false'}
				aria-describedby={statusId}
				onkeydown={(e) => handleKeydown(e, target)}
			/>
			<p id={statusId} class="status" class:rejected={isRejected} class:locked>
				{#if locked}
					{m.text_answer_locked()}
				{:else if isRejected}
					{m.text_answer_rejected()}
				{:else}
					&nbsp;
				{/if}
			</p>
		</div>
	{/each}
	<!-- Not `aria-hidden`: "Enter locks it in" is the whole interaction model
	     here (there is no submit button, ANS-1), so it matters most to the
	     people who can't see the inputs. Dropped once nothing is left to lock
	     so it never contradicts the screen. -->
	{#if required.some((target) => !isLocked(target))}
		<p class="hint">{m.text_answer_hint()}</p>
	{/if}
</div>

<style>
	.text-answer {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	/* The answer is the loudest thing on the screen while a clip is playing:
	   display face, oversized, so a player glancing down mid-clip reads their
	   own guess at a glance. */
	input {
		font-family: var(--font-display);
		font-size: var(--text-display);
		padding-block: var(--space-2);
	}

	.is-locked input:disabled {
		color: var(--positive);
		border-bottom-color: var(--positive);
		border-bottom-style: solid;
		opacity: 1;
	}

	.status {
		min-height: 1.4em;
		margin: 0;
		font-size: var(--text-small);
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	/* Icons via pseudo-elements, never text nodes: `.status`'s textContent is
	   asserted verbatim ("Locked in") by the solo happy-path e2e, and it is
	   also what a screen reader announces through `aria-describedby`. A "✓" in
	   the markup would leak into both. */
	.status.locked {
		color: var(--positive);
		animation: stamp var(--dur) var(--ease) both;
		/* Block-level text scaled from its centre slides sideways as it grows;
		   anchoring the origin to the text's own start edge keeps "Locked in"
		   put and makes it read as a stamp rather than a slide. */
		transform-origin: left center;
	}

	.status.locked::before {
		content: '✓ ';
	}

	.status.rejected {
		color: var(--negative);
	}

	.status.rejected::before {
		content: '↺ ';
	}

	.hint {
		margin: 0;
		font-size: var(--text-micro);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-faint);
	}

	@media (prefers-reduced-motion: reduce) {
		input {
			transition: none;
		}
	}
</style>
