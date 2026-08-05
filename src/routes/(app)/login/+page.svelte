<script lang="ts">
	/**
	 * Sign in — technical-spec §12, plan task 2.2.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { signIn, ApiError } from '$lib/client/api.js';
	import { m } from '$lib/paraglide/messages.js';
	import { localizeApiErrorCode } from '$lib/client/errors.js';

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
			error = err instanceof ApiError ? localizeApiErrorCode(err.code) : m.api_error_internal();
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>{m.title_login()}</title>
</svelte:head>

<main>
	<section class="panel">
		<h1>{m.login_heading()}</h1>
		<form onsubmit={handleSubmit} novalidate>
			<div class="field">
				<label for="login-email">{m.login_label_email()}</label>
				<input id="login-email" type="email" autocomplete="email" required bind:value={email} />
			</div>

			<div class="field">
				<label for="login-password">{m.login_label_password()}</label>
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
				{submitting ? m.login_button_submitting() : m.login_button_submit()}
			</button>
		</form>
		<p class="switch">
			{m.login_switch_prompt()} <a href={resolve('/(app)/signup')}>{m.login_switch_link()}</a>
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
