<script lang="ts">
	/** FRIEND-1 invite link — plan task 3.7/3.14. */
	import { resolve } from '$app/paths';
	import { ApiError } from '$lib/client/api.js';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages.js';

	const { data }: PageProps = $props();

	let state = $state<'idle' | 'sending' | 'sent' | 'needs_auth' | 'error'>('idle');

	async function addFriend(): Promise<void> {
		state = 'sending';
		try {
			const response = await fetch('/api/friends/request', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId: data.inviter.userId })
			});
			if (response.status === 401) {
				state = 'needs_auth';
				return;
			}
			if (!response.ok) throw new ApiError(response.status, 'internal', 'Request failed.');
			state = 'sent';
		} catch {
			state = 'error';
		}
	}
</script>

<svelte:head>
	<title>{m.title_invite({ name: data.inviter.displayName })}</title>
	<meta name="description" content={m.invite_description({ name: data.inviter.displayName })} />
	<meta property="og:title" content={m.invite_og_title({ name: data.inviter.displayName })} />
	<meta property="og:description" content={m.invite_og_description()} />
	<meta property="og:image" content="/og-branded.png" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<main class="sheet">
	<p class="eyebrow">{m.invite_eyebrow()}</p>
	<h1>{m.invite_heading({ name: data.inviter.displayName })}</h1>

	{#if state === 'sent'}
		<p class="muted">{m.invite_sent()}</p>
	{:else if state === 'needs_auth'}
		<p class="muted">{m.invite_needs_auth({ name: data.inviter.displayName })}</p>
		<div class="actions">
			<a class="btn" href={resolve('/login')}>{m.invite_sign_in()}</a>
			<a class="btn" href={resolve('/signup')}>{m.invite_sign_up()}</a>
		</div>
	{:else}
		<button type="button" onclick={addFriend} disabled={state === 'sending'}>
			{state === 'sending' ? m.invite_button_sending() : m.invite_button_add()}
		</button>
		{#if state === 'error'}
			<p class="error-note">{m.invite_error()}</p>
		{/if}
	{/if}

	<a class="btn quiet" href={resolve('/')}>{m.invite_go_to_devinyl()}</a>
</main>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.eyebrow {
		margin: 0;
		font-size: var(--text-micro);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.actions {
		display: flex;
		gap: var(--space-3);
	}

	.error-note {
		margin: 0;
		padding: var(--space-3);
		background: var(--negative-soft);
		border-left: 3px solid var(--negative);
		border-radius: var(--radius-sm);
	}
</style>
