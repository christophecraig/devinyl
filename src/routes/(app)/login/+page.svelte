<script lang="ts">
	/**
	 * Sign in — technical-spec §12, plan task 2.2.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { signIn, signInWithGoogle, ApiError } from '$lib/client/api.js';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	const { data }: PageProps = $props();

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
			// Better Auth's own error responses carry only `message`, no `code`
			// our envelope understands (`send()`'s `code` default of 'internal'
			// would be actively misleading here) — this app's own hook messages
			// in `auth.ts` are localized at the source via Paraglide; Better
			// Auth's built-in ones (wrong password, etc.) stay English, a known
			// scope boundary rather than a re-implementation of its i18n.
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

		{#if data.googleEnabled}
			<div class="divider" role="separator"><span>{m.auth_or_divider()}</span></div>
			<button class="start" type="button" onclick={handleGoogle}>
				{m.auth_continue_with_google()}
			</button>
		{/if}

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
