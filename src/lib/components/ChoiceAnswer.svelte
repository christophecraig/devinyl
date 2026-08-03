<script lang="ts">
	/**
	 * Multiple-choice answer UI — technical-spec ANS-6/7, task 1.25.
	 *
	 * One `<fieldset>`/`<legend>` group per required target (`title`/`artist`),
	 * each holding a `role="listbox"` of its 4 plaintext options. **Listbox, not
	 * native radio inputs**: a native `<input type="radio">` group *selects* the
	 * radio the moment arrow-key focus lands on it, which is exactly what ANS-7
	 * forbids here — a pick is final and irreversible (no retries, unlike free
	 * text), so a stray arrow press must never trigger one. The listbox pattern
	 * (ARIA APG "listbox, selection does not follow focus") decouples the two:
	 * arrow keys move a single roving `aria-activedescendant` pointer across the
	 * options — a real, but non-committing, keyboard interaction — and only an
	 * explicit Enter/Space/click commits. The `<fieldset>`/`<legend>` wrapper is
	 * kept regardless, purely for grouping and the accessible name of each
	 * target's listbox (via `aria-labelledby`), matching this repo's other forms
	 * (see `NicknamePrompt.svelte`).
	 *
	 * Order is a per-session, per-round, per-target deterministic shuffle
	 * (`shuffle.ts`) rather than `Math.random()`: it must stay put across
	 * re-renders within the same round (a random reorder mid-round would move
	 * the option the player is about to tap) while still differing session to
	 * session, so the correct answer never settles into a predictable slot.
	 *
	 * Correctness is never revealed here (that is the reveal phase's job, per
	 * the plan): a pick is only ever shown as "chosen", never as "right" or
	 * "wrong", and only `onattempt`'s boolean tells the caller (for
	 * announcements) whether `game.submitGuess()` accepted it.
	 */
	import type { Game } from '$lib/client/game-state.svelte.js';
	import type { RoundChoices, TargetName } from '$lib/game/types.js';
	import { seededShuffle } from '$lib/client/shuffle.js';

	interface Props {
		game: Game;
		required: TargetName[];
		choices: RoundChoices;
		sessionId: string;
		position: number;
		onattempt?: (target: TargetName, accepted: boolean) => void;
	}

	let { game, required, choices, sessionId, position, onattempt }: Props = $props();

	const TARGET_LABEL: Record<TargetName, string> = { title: 'Title', artist: 'Artist' };

	/** The committed option text per target, once the player has locked one in (ANS-7). */
	let picked = $state<Partial<Record<TargetName, string>>>({});
	/** Roving `aria-activedescendant` index per target — focus position, not a selection. */
	let activeIndex = $state<Partial<Record<TargetName, number>>>({});

	/** Only targets that are required for this quiz *and* actually have options to show. */
	const groups = $derived(
		required
			.map((target) => ({
				target,
				options: seededShuffle(choices[target] ?? [], sessionId, position, target)
			}))
			.filter((group) => group.options.length > 0)
	);

	function isLocked(target: TargetName): boolean {
		return target in picked;
	}

	function activeIndexFor(target: TargetName, count: number): number {
		return Math.min(activeIndex[target] ?? 0, count - 1);
	}

	function moveActive(target: TargetName, count: number, delta: number): void {
		const current = activeIndexFor(target, count);
		activeIndex = { ...activeIndex, [target]: (current + delta + count) % count };
	}

	function setActive(target: TargetName, index: number): void {
		activeIndex = { ...activeIndex, [target]: index };
	}

	/**
	 * Commits `options[index]` as the final pick for `target` (ANS-7: one pick,
	 * no retries — unlike free text's independent-attempts model). Reads
	 * `game.lockedTargets` before/after `submitGuess()` to learn whether it was
	 * accepted, purely to report it via `onattempt`; the UI locks either way.
	 */
	function commit(target: TargetName, options: string[], index: number): void {
		if (isLocked(target)) return;
		const option = options[index];
		const wasLocked = game.lockedTargets.includes(target);
		game.submitGuess(target, option);
		const accepted = !wasLocked && game.lockedTargets.includes(target);
		picked = { ...picked, [target]: option };
		onattempt?.(target, accepted);
	}

	/** Arrow keys only ever move the roving pointer — never commit (see module doc). */
	function handleKeydown(event: KeyboardEvent, target: TargetName, options: string[]): void {
		if (isLocked(target)) return;
		const count = options.length;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowRight':
				event.preventDefault();
				moveActive(target, count, 1);
				break;
			case 'ArrowUp':
			case 'ArrowLeft':
				event.preventDefault();
				moveActive(target, count, -1);
				break;
			case 'Home':
				event.preventDefault();
				setActive(target, 0);
				break;
			case 'End':
				event.preventDefault();
				setActive(target, count - 1);
				break;
			case 'Enter':
			case ' ':
			case 'Spacebar':
				event.preventDefault();
				commit(target, options, activeIndexFor(target, count));
				break;
		}
	}
</script>

<div class="choice-answer">
	{#each groups as { target, options } (target)}
		{@const locked = isLocked(target)}
		{@const active = activeIndexFor(target, options.length)}
		{@const legendId = `choice-legend-${position}-${target}`}
		<fieldset class="choice-group">
			<legend id={legendId}>{TARGET_LABEL[target]}</legend>
			<div
				role="listbox"
				aria-labelledby={legendId}
				aria-disabled={locked}
				aria-activedescendant={locked ? undefined : `choice-${position}-${target}-${active}`}
				tabindex={locked ? -1 : 0}
				class="listbox"
				onkeydown={(event) => handleKeydown(event, target, options)}
			>
				{#each options as option, index (option)}
					<div
						id={`choice-${position}-${target}-${index}`}
						role="option"
						tabindex="-1"
						aria-selected={picked[target] === option}
						aria-disabled={locked}
						class="option"
						class:active={!locked && index === active}
						class:picked={picked[target] === option}
						onclick={() => commit(target, options, index)}
						onkeydown={(event) => handleKeydown(event, target, options)}
					>
						{option}
					</div>
				{/each}
			</div>
		</fieldset>
	{/each}
</div>

<style>
	.choice-answer {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.choice-group {
		border: 1px solid;
		border-radius: 0.25rem;
		padding: 0.75rem;
	}

	legend {
		font-weight: 600;
		padding: 0 0.25rem;
	}

	.listbox {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		outline: none;
	}

	.option {
		padding: 0.5rem 0.75rem;
		border: 1px solid;
		border-radius: 0.25rem;
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease;
	}

	.option.active {
		outline: 2px solid;
		outline-offset: 2px;
	}

	.option.picked {
		font-weight: 600;
		border-width: 2px;
	}

	.listbox[aria-disabled='true'] .option {
		cursor: default;
		opacity: 0.6;
	}

	.listbox[aria-disabled='true'] .option.picked {
		opacity: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.option {
			transition: none;
		}
	}
</style>
