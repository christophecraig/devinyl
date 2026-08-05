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
	import { m } from '$lib/paraglide/messages.js';

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
		return parsed.success ? null : m.nickname_error();
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
	<label for="nickname-prompt-input">{m.nickname_label()}</label>
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
	<button class="primary" type="submit">{m.nickname_continue()}</button>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-width: 22rem;
	}

	input {
		font-size: var(--text-title);
		font-family: var(--font-display);
	}

	.error {
		min-height: 1.2em;
		margin: 0;
		font-size: var(--text-small);
		color: var(--negative);
	}

	button {
		align-self: flex-start;
		margin-top: var(--space-2);
	}
</style>
