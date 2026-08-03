<script lang="ts">
	/**
	 * Nickname prompt — technical-spec §4 "Guest identity" (ACC-1), FAIR-5.
	 *
	 * Shape-only client validation (length + characters, mirroring
	 * `$lib/game/schemas.ts`'s `nicknameSchema`), the same "client validates for
	 * instant feedback, server is the authority" split §7.2 uses for guesses.
	 * Profanity (FAIR-5) is deliberately *not* checked here: the curated lists
	 * live in `src/lib/server/profanity.ts` and only run server-side, at the
	 * point a nickname is actually set (`POST /api/sessions`, challenge join) —
	 * shipping them to the client would leak the blocklist to anyone reading the
	 * bundle. A profanity rejection therefore surfaces through `onsubmit`'s
	 * caller (the API error path), not from this component.
	 */
	import { untrack } from 'svelte';
	import { nicknameSchema } from '$lib/game/schemas.js';

	let { initial = '', onsubmit }: { initial?: string; onsubmit: (name: string) => void } = $props();

	// `untrack`: the field is seeded from `initial` once and then locally
	// owned (an uncontrolled input) — it must not re-sync if the prop changes
	// later, which is exactly what a direct `$state(initial)` reference warns
	// about (state_referenced_locally).
	let value = $state(untrack(() => initial));
	let error = $state<string | null>(null);

	const ERROR_ID = 'nickname-prompt-error';

	function validate(name: string): string | null {
		const parsed = nicknameSchema.safeParse(name);
		return parsed.success
			? null
			: "Pick a nickname between 2 and 24 characters (letters, numbers, spaces, - . ' only).";
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		const result = nicknameSchema.safeParse(value);
		if (!result.success) {
			error = validate(value);
			return;
		}
		error = null;
		onsubmit(result.data);
	}
</script>

<form onsubmit={handleSubmit} novalidate>
	<label for="nickname-prompt-input">Nickname</label>
	<input
		id="nickname-prompt-input"
		name="nickname"
		type="text"
		autocomplete="off"
		maxlength="24"
		bind:value
		aria-invalid={error ? 'true' : 'false'}
		aria-describedby={ERROR_ID}
	/>
	<p id={ERROR_ID} aria-live="polite" class="error">{error ?? ''}</p>
	<button type="submit">Continue</button>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 20rem;
	}

	label {
		font-weight: 600;
	}

	input {
		padding: 0.5rem;
		font-size: 1rem;
		border: 1px solid;
		border-radius: 0.25rem;
	}

	input[aria-invalid='true'] {
		border-color: #c0392b;
	}

	.error {
		min-height: 1.2em;
		margin: 0;
		font-size: 0.875rem;
		color: #c0392b;
	}

	button {
		align-self: flex-start;
		padding: 0.5rem 1rem;
		font-size: 1rem;
		cursor: pointer;
	}
</style>
