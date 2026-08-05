<script lang="ts">
	/**
	 * Multiple-choice answer UI — technical-spec ANS-6/7/8, QUIZ-7, task 1.25.
	 *
	 * One `<fieldset>`/`<legend>` group per required target (`title`/`artist`),
	 * each holding a `role="listbox"` of its 4 plaintext options. **Listbox, not
	 * native radio inputs**: a native `<input type="radio">` group *selects* the
	 * radio the moment arrow-key focus lands on it, which is not what we want
	 * here — a stray arrow press must never commit a pick. The listbox pattern
	 * (ARIA APG "listbox, selection does not follow focus") decouples the two:
	 * arrow keys move a single roving `aria-activedescendant` pointer across the
	 * options — a real, but non-committing, keyboard interaction — and only an
	 * explicit Enter/Space/click commits. The `<fieldset>`/`<legend>` wrapper is
	 * kept regardless, purely for grouping and the accessible name of each
	 * target's listbox (via `aria-labelledby`), matching this repo's other forms
	 * (see `NicknamePrompt.svelte`).
	 *
	 * Whether a wrong pick locks the whole group depends on the quiz's
	 * `retryMode` (QUIZ-7):
	 *
	 * - **`oneShot`** (ANS-7): a pick — right or wrong — is final and locks the
	 *   group immediately. This exists so a wrong guess never strands the
	 *   player staring at a dead screen until the clip ends: the target is
	 *   simply over, and the round can move on (ROUND-3) the moment every
	 *   required target is settled, exactly like a correct answer would.
	 * - **`penalty`** (ANS-8): a wrong pick disables the whole group for
	 *   `penaltySeconds`, then reopens it for another attempt — for as long as
	 *   the clip plays. The delay (not a scoring penalty — see module doc on
	 *   `game-state.svelte.ts`) is what stops a player from machine-gunning all
	 *   4 options, while still letting a miss be recovered from.
	 *
	 * Order is a per-session, per-round, per-target deterministic shuffle
	 * (`shuffle.ts`) rather than `Math.random()`: it must stay put across
	 * re-renders within the same round (a random reorder mid-round would move
	 * the option the player is about to tap) while still differing session to
	 * session, so the correct answer never settles into a predictable slot.
	 *
	 * A picked option (right, or wrong-and-final under `oneShot`) is shown as
	 * "chosen". The *correct* option is never singled out here — that's still
	 * the reveal phase's job; a wrong pick under `penalty` doesn't stay marked
	 * once the group reopens; a player could land on the same wrong option
	 * again, same as any other. `onattempt`'s boolean tells the caller (for
	 * announcements) whether `game.submitGuess()` accepted the pick.
	 */
	import type { Game } from '$lib/client/game-state.svelte.js';
	import type { ChoiceRetryMode, RoundChoices, TargetName } from '$lib/game/types.js';
	import { seededShuffle } from '$lib/client/shuffle.js';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		game: Game;
		required: TargetName[];
		choices: RoundChoices;
		sessionId: string;
		position: number;
		retryMode: ChoiceRetryMode;
		/** Seconds the group stays disabled after a wrong pick, `retryMode: 'penalty'` only (ANS-8). */
		penaltySeconds: number;
		onattempt?: (target: TargetName, accepted: boolean) => void;
	}

	let {
		game,
		required,
		choices,
		sessionId,
		position,
		retryMode,
		penaltySeconds,
		onattempt
	}: Props = $props();

	const TARGET_LABEL: Record<TargetName, string> = {
		title: m.common_label_title(),
		artist: m.common_label_artist()
	};

	/** The committed option text per target, once a pick has become final (correct, or wrong under `oneShot`). */
	let picked = $state<Partial<Record<TargetName, string>>>({});
	/** Whether the committed pick was correct — drives the "chosen" vs "chosen, wrong, locked" status text. */
	let pickedCorrect = $state<Partial<Record<TargetName, boolean>>>({});
	/** `retryMode: 'penalty'` only: wall-clock ms until which the group is disabled after a wrong pick. */
	let penaltyUntil = $state<Partial<Record<TargetName, number>>>({});
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

	function isFinal(target: TargetName): boolean {
		return target in picked;
	}

	function isPenalized(target: TargetName): boolean {
		return (penaltyUntil[target] ?? 0) > Date.now();
	}

	function isDisabled(target: TargetName): boolean {
		return isFinal(target) || isPenalized(target);
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
	 * Commits `options[index]` as a pick for `target`. Reads `game.lockedTargets`
	 * before/after `submitGuess()` to learn whether it was accepted. A correct
	 * pick always finalizes the group. A wrong pick finalizes it too under
	 * `oneShot` (ANS-7); under `penalty` it instead starts a `penaltySeconds`
	 * lockout (ANS-8) after which the group reopens on its own.
	 */
	function commit(target: TargetName, options: string[], index: number): void {
		if (isDisabled(target)) return;
		const option = options[index];
		const wasLocked = game.lockedTargets.includes(target);
		game.submitGuess(target, option);
		const accepted = !wasLocked && game.lockedTargets.includes(target);
		if (accepted) {
			picked = { ...picked, [target]: option };
			pickedCorrect = { ...pickedCorrect, [target]: true };
		} else if (retryMode === 'oneShot') {
			picked = { ...picked, [target]: option };
			pickedCorrect = { ...pickedCorrect, [target]: false };
		} else if (penaltySeconds > 0) {
			penaltyUntil = { ...penaltyUntil, [target]: Date.now() + penaltySeconds * 1000 };
			setTimeout(() => {
				penaltyUntil = { ...penaltyUntil, [target]: undefined };
			}, penaltySeconds * 1000);
		}
		onattempt?.(target, accepted);
	}

	/** Arrow keys only ever move the roving pointer — never commit (see module doc). */
	function handleKeydown(event: KeyboardEvent, target: TargetName, options: string[]): void {
		if (isDisabled(target)) return;
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
		{@const final = isFinal(target)}
		{@const penalized = isPenalized(target)}
		{@const disabled = final || penalized}
		{@const active = activeIndexFor(target, options.length)}
		{@const legendId = `choice-legend-${position}-${target}`}
		{@const statusId = `choice-status-${position}-${target}`}
		<fieldset class="choice-group">
			<legend id={legendId}>{TARGET_LABEL[target]}</legend>
			<div
				role="listbox"
				aria-labelledby={legendId}
				aria-describedby={statusId}
				aria-disabled={disabled}
				aria-activedescendant={disabled ? undefined : `choice-${position}-${target}-${active}`}
				tabindex={disabled ? -1 : 0}
				class="listbox"
				onkeydown={(event) => handleKeydown(event, target, options)}
			>
				{#each options as option, index (option)}
					{@const chosen = picked[target] === option}
					<div
						id={`choice-${position}-${target}-${index}`}
						role="option"
						tabindex="-1"
						aria-selected={chosen}
						aria-disabled={disabled}
						class="option"
						class:active={!disabled && index === active}
						class:picked={chosen}
						class:wrong={chosen && pickedCorrect[target] === false}
						onclick={() => commit(target, options, index)}
						onkeydown={(event) => handleKeydown(event, target, options)}
					>
						{option}
					</div>
				{/each}
			</div>
			<p
				id={statusId}
				class="status"
				class:locked={final && pickedCorrect[target] === true}
				class:penalized={penalized || (final && pickedCorrect[target] === false)}
			>
				{#if final}
					{pickedCorrect[target] ? m.choice_answer_locked() : m.choice_answer_wrong_locked()}
				{:else if penalized}
					{m.choice_answer_penalized({ seconds: penaltySeconds })}
				{:else}
					&nbsp;
				{/if}
			</p>
		</fieldset>
	{/each}
</div>

<style>
	.choice-answer {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.choice-group {
		padding: var(--space-3);
		background: var(--surface-raised);
		box-shadow: var(--shadow-card);
	}

	legend {
		padding: 0 var(--space-2);
		text-transform: uppercase;
		font-size: var(--text-micro);
		letter-spacing: 0.14em;
		color: var(--accent-ink);
	}

	.listbox {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		outline: none;
	}

	.option {
		padding: var(--space-3);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
		background: var(--surface);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) var(--ease),
			border-color var(--dur-fast) var(--ease),
			transform var(--dur-fast) var(--ease);
	}

	.option:hover {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	/* The roving `aria-activedescendant` pointer. It has to look like focus
	   without *being* focus (the listbox keeps the real focus — see the module
	   doc), so it borrows the app's focus ring deliberately. */
	.option.active {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-color: var(--accent);
	}

	/* Committed and correct — final for the group, so it reads as a stamp, not
	   a highlight. Still never says "right" itself: that's the reveal's job. */
	.option.picked {
		font-weight: 600;
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		animation: stamp var(--dur) var(--ease) both;
	}

	/* Committed and wrong (oneShot only — a wrong pick is still final there),
	   distinguished from a correct pick without ever naming the right one. */
	.option.picked.wrong {
		background: var(--surface);
		border-color: var(--negative);
		color: var(--ink);
	}

	.option[aria-disabled='true'] {
		cursor: default;
		opacity: 0.55;
	}

	.option[aria-disabled='true']:hover {
		border-color: var(--rule);
		background: var(--surface);
	}

	.option[aria-disabled='true'].picked {
		opacity: 1;
	}

	.option[aria-disabled='true'].picked:hover {
		background: var(--accent);
		border-color: var(--accent);
	}

	.option[aria-disabled='true'].picked.wrong:hover {
		background: var(--surface);
		border-color: var(--negative);
	}

	.status {
		min-height: 1.4em;
		margin: var(--space-2) 0 0;
		font-size: var(--text-small);
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.status.locked {
		color: var(--positive);
	}

	.status.penalized {
		color: var(--negative);
	}

	@media (prefers-reduced-motion: reduce) {
		.option {
			transition: none;
		}
	}
</style>
