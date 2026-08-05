<script lang="ts">
	/**
	 * Post-OAuth profile completion — see `auth.ts`'s module doc on the
	 * OAuth/age-gate split. Reachable only via the root layout's redirect
	 * (`+layout.server.ts`): a signed-in user whose `birthYear` is still null
	 * lands here before anything else in the app, and gets redirected right
	 * back out the moment it's set. `currentDisplayName` (root layout data)
	 * pre-fills the field with the auto-derived name from `auth.ts` so the
	 * player only has to touch it if they don't like what was picked for them.
	 */
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { completeProfile, ApiError } from '$lib/client/api.js';
	import { MIN_SIGNUP_AGE } from '$lib/game/types.js';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	const { data }: PageProps = $props();

	// `untrack`: seeded once from the auto-derived name, then locally owned
	// (uncontrolled input) — same pattern as NicknamePrompt.svelte's `initial`.
	let displayName = $state(untrack(() => data.currentDisplayName ?? ''));
	let birthYear = $state<number | ''>('');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (submitting) return;
		if (birthYear === '') {
			error = m.signup_error_birth_year_required();
			return;
		}

		submitting = true;
		error = null;
		try {
			await completeProfile({ displayName, birthYear });
			await invalidateAll();
			await goto(resolve('/'));
		} catch (err) {
			error = err instanceof ApiError ? err.message : m.api_error_internal();
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>{m.title_complete_profile()}</title>
</svelte:head>

<main>
	<section class="panel">
		<h1>{m.complete_profile_heading()}</h1>
		<p class="intro">{m.complete_profile_intro()}</p>
		<form onsubmit={handleSubmit} novalidate>
			<div class="field">
				<label for="complete-profile-display-name">{m.complete_profile_label_display_name()}</label>
				<input
					id="complete-profile-display-name"
					type="text"
					autocomplete="nickname"
					maxlength="24"
					required
					bind:value={displayName}
				/>
			</div>

			<div class="field">
				<label for="complete-profile-birth-year">{m.complete_profile_label_birth_year()}</label>
				<input
					id="complete-profile-birth-year"
					type="number"
					inputmode="numeric"
					min="1900"
					max={new Date().getFullYear()}
					required
					bind:value={birthYear}
				/>
				<p class="hint">{m.complete_profile_birth_year_hint({ age: MIN_SIGNUP_AGE })}</p>
			</div>

			<p class="error" role="alert">{error ?? ''}</p>

			<button class="primary start" type="submit" disabled={submitting}>
				{submitting ? m.complete_profile_button_submitting() : m.complete_profile_button_submit()}
			</button>
		</form>
	</section>
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
		padding: var(--space-5) var(--space-4);
	}

	.intro {
		margin: calc(var(--space-3) * -1) 0 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.hint {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	.error {
		min-height: 1.2em;
		margin: 0;
		font-size: var(--text-small);
		color: var(--negative);
	}

	.start {
		align-self: stretch;
		margin-top: var(--space-1);
	}
</style>
