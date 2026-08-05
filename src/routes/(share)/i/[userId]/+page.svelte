<script lang="ts">
	/** FRIEND-1 invite link — plan task 3.7/3.14. */
	import { resolve } from '$app/paths';
	import { ApiError } from '$lib/client/api.js';
	import type { PageProps } from './$types';

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
	<title>Devinyl — {data.inviter.displayName} invites you</title>
	<meta name="description" content="{data.inviter.displayName} wants to be friends on Devinyl." />
	<meta property="og:title" content="{data.inviter.displayName} invites you to Devinyl" />
	<meta
		property="og:description"
		content="Add each other, compare boards, and challenge each other's scores."
	/>
	<meta property="og:image" content="/og-branded.png" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<main class="sheet">
	<p class="eyebrow">Friend invite</p>
	<h1>{data.inviter.displayName} invites you to Devinyl</h1>

	{#if state === 'sent'}
		<p class="muted">Friend request sent.</p>
	{:else if state === 'needs_auth'}
		<p class="muted">Sign in or create an account to add {data.inviter.displayName} as a friend.</p>
		<div class="actions">
			<a class="btn" href={resolve('/login')}>Sign in</a>
			<a class="btn" href={resolve('/signup')}>Sign up</a>
		</div>
	{:else}
		<button type="button" onclick={addFriend} disabled={state === 'sending'}>
			{state === 'sending' ? 'Sending…' : 'Add as friend'}
		</button>
		{#if state === 'error'}
			<p class="error-note">Something went wrong — try again.</p>
		{/if}
	{/if}

	<a class="btn quiet" href={resolve('/')}>Go to Devinyl</a>
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
