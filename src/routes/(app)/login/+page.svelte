<script lang="ts">
	/**
	 * Sign in — technical-spec §12, plan task 2.2.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { signIn, ApiError } from '$lib/client/api.js';

	let email = $state('');
	let password = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (submitting) return;

		submitting = true;
		error = null;
		try {
			await signIn({ email, password });
			await goto(resolve('/(app)'));
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in — Devinyl</title>
</svelte:head>

<main>
	<section class="panel">
		<h1>Sign in</h1>
		<form onsubmit={handleSubmit} novalidate>
			<div class="field">
				<label for="login-email">Email</label>
				<input id="login-email" type="email" autocomplete="email" required bind:value={email} />
			</div>

			<div class="field">
				<label for="login-password">Password</label>
				<input
					id="login-password"
					type="password"
					autocomplete="current-password"
					required
					bind:value={password}
				/>
			</div>

			<p class="error" role="alert">{error ?? ''}</p>

			<button class="primary start" type="submit" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
		<p class="switch">
			No account yet? <a href={resolve('/(app)/signup')}>Create one</a>
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
