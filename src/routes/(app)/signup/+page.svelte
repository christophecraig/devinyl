<script lang="ts">
	/**
	 * Sign up — technical-spec §12, plan task 2.2/2.5 (ACC-3, ACC-4, LEGAL-1).
	 *
	 * Email+password only here — Google (ACC-3) has no credentials yet (task
	 * 2.1, [USER]) so `auth.ts` never registers the provider, and there is
	 * nothing for a "Sign up with Google" button to call.
	 *
	 * On success: import the local guest blob (ACC-4) so this account doesn't
	 * lose the history it played before signing up, clear the blob (a stale
	 * `guestId` must never re-attribute a later account's sessions onto this
	 * one), then go home signed in.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { signUp, importGuestHistory, ApiError } from '$lib/client/api.js';
	import { loadGuest, clearGuest } from '$lib/client/guest.js';
	import { MIN_SIGNUP_AGE } from '$lib/game/types.js';

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
			error = 'Enter your birth year.';
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
			error = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign up — Devinyl</title>
</svelte:head>

<main>
	<section class="panel">
		<h1>Create an account</h1>
		<form onsubmit={handleSubmit} novalidate>
			<div class="field">
				<label for="signup-email">Email</label>
				<input id="signup-email" type="email" autocomplete="email" required bind:value={email} />
			</div>

			<div class="field">
				<label for="signup-password">Password</label>
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
				<label for="signup-display-name">Display name</label>
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
				<label for="signup-birth-year">Birth year</label>
				<input
					id="signup-birth-year"
					type="number"
					inputmode="numeric"
					min="1900"
					max={new Date().getFullYear()}
					required
					bind:value={birthYear}
				/>
				<p class="hint">You must be at least {MIN_SIGNUP_AGE} to create an account.</p>
			</div>

			<p class="error" role="alert">{error ?? ''}</p>

			<button class="primary start" type="submit" disabled={submitting}>
				{submitting ? 'Creating account…' : 'Create account'}
			</button>
		</form>
		<p class="switch">Already have an account? <a href={resolve('/(app)/login')}>Sign in</a></p>
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

	.switch {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}
</style>
