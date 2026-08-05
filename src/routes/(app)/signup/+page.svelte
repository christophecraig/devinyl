<script lang="ts">
	/**
	 * Sign up — technical-spec §12, plan task 2.2/2.5 (ACC-3, ACC-4, LEGAL-1).
	 *
	 * Google (ACC-3) renders a "Continue with Google" button once
	 * `data.googleEnabled` is true (task 2.1's credentials are set) — a
	 * first-time Google signer skips this form entirely and instead lands on
	 * `/complete-profile` after the OAuth callback, since Google never hands
	 * back a birth year (see `auth.ts`'s module doc).
	 *
	 * On success: import the local guest blob (ACC-4) so this account doesn't
	 * lose the history it played before signing up, clear the blob (a stale
	 * `guestId` must never re-attribute a later account's sessions onto this
	 * one), then go home signed in.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { signUp, signInWithGoogle, importGuestHistory, ApiError } from '$lib/client/api.js';
	import { loadGuest, clearGuest } from '$lib/client/guest.js';
	import { MIN_SIGNUP_AGE } from '$lib/game/types.js';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	const { data }: PageProps = $props();

	let email = $state('');
	let password = $state('');
	let displayName = $state('');
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
			await signUp({ email, password, displayName, birthYear });

			const guest = loadGuest();
			try {
				await importGuestHistory({
					guestId: guest.guestId,
					history: guest.history.map((h) => ({
						sessionId: h.sessionId,
						quizId: h.quizId,
						score: h.score,
						playedAt: h.playedAt
					}))
				});
			} catch {
				// Import failing must never block account creation — the account
				// already exists and is usable; the local history just stays local.
			}
			clearGuest();

			await goto(resolve('/(app)'));
		} catch (err) {
			// Same rationale as login/+page.svelte: Better Auth's error body has
			// no `code`, and this app's own hook messages (auth.ts) are
			// localized at the source, so the raw message is the right thing
			// to show — see that file's comment for the full explanation.
			error = err instanceof ApiError ? err.message : m.api_error_internal();
		} finally {
			submitting = false;
		}
	}

	async function handleGoogle(): Promise<void> {
		error = null;
		try {
			await signInWithGoogle(); // navigates away on success — nothing to await after
		} catch (err) {
			error = err instanceof ApiError ? err.message : m.api_error_internal();
		}
	}
</script>

<svelte:head>
	<title>{m.title_signup()}</title>
</svelte:head>

<main>
	<section class="panel">
		<h1>{m.signup_heading()}</h1>
		<form onsubmit={handleSubmit} novalidate>
			<div class="field">
				<label for="signup-email">{m.signup_label_email()}</label>
				<input id="signup-email" type="email" autocomplete="email" required bind:value={email} />
			</div>

			<div class="field">
				<label for="signup-password">{m.signup_label_password()}</label>
				<input
					id="signup-password"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
					bind:value={password}
				/>
			</div>

			<div class="field">
				<label for="signup-display-name">{m.signup_label_display_name()}</label>
				<input
					id="signup-display-name"
					type="text"
					autocomplete="nickname"
					maxlength="24"
					required
					bind:value={displayName}
				/>
			</div>

			<div class="field">
				<label for="signup-birth-year">{m.signup_label_birth_year()}</label>
				<input
					id="signup-birth-year"
					type="number"
					inputmode="numeric"
					min="1900"
					max={new Date().getFullYear()}
					required
					bind:value={birthYear}
				/>
				<p class="hint">{m.signup_birth_year_hint({ age: MIN_SIGNUP_AGE })}</p>
			</div>

			<p class="error" role="alert">{error ?? ''}</p>

			<button class="primary start" type="submit" disabled={submitting}>
				{submitting ? m.signup_button_submitting() : m.signup_button_submit()}
			</button>
		</form>

		{#if data.googleEnabled}
			<div class="divider" role="separator"><span>{m.auth_or_divider()}</span></div>
			<button class="start" type="button" onclick={handleGoogle}>
				{m.auth_continue_with_google()}
			</button>
		{/if}

		<p class="switch">
			{m.signup_switch_prompt()} <a href={resolve('/(app)/login')}>{m.signup_switch_link()}</a>
		</p>
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

	.divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-micro);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-faint);
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--rule);
	}

	.switch {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}
</style>
