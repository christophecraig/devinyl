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

	interface Props {
		game: Game;
		required: TargetName[];
		/** Fires on every submit so the page can announce it (A11Y-2). */
		onattempt?: (target: TargetName, accepted: boolean) => void;
	}

	let { game, required, onattempt }: Props = $props();

	const LABEL: Record<TargetName, string> = { title: 'Title', artist: 'Artist' };

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
		<div class="field">
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
					Locked in
				{:else if isRejected}
					Not that one
				{:else}
					&nbsp;
				{/if}
			</p>
		</div>
	{/each}
</div>

<style>
	.text-answer {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	label {
		font-weight: 600;
	}

	input {
		padding: 0.5rem;
		font-size: 1rem;
		border: 1px solid;
		border-radius: 0.25rem;
		transition: border-color 0.15s ease;
	}

	@media (prefers-reduced-motion: reduce) {
		input {
			transition: none;
		}
	}

	input:disabled {
		opacity: 0.7;
	}

	input[aria-invalid='true'] {
		border-color: #c0392b;
	}

	.status {
		min-height: 1.2em;
		margin: 0;
		font-size: 0.875rem;
	}

	.status.rejected {
		color: #c0392b;
	}

	.status.locked {
		color: #1e8449;
	}
</style>
