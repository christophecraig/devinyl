<script lang="ts">
	/**
	 * Daily quiz — DAILY-1/2/5, plan task 3.1. Client-fetched like `/play`
	 * (no unfurl requirement here, unlike the challenge lobby — task 3.14
	 * only asks for OG meta on `/q/`, `/c/`, `/i/`).
	 */
	import { onMount } from 'svelte';
	import PlayQuiz from '$lib/components/PlayQuiz.svelte';
	import { getDaily, ApiError, type DailyInfo } from '$lib/client/api.js';

	let daily = $state<DailyInfo | null>(null);
	let error = $state<ApiError | null>(null);

	onMount(() => {
		getDaily()
			.then((d) => {
				daily = d;
			})
			.catch((err: unknown) => {
				error = err instanceof ApiError ? err : new ApiError(0, 'network_error', 'Network error.');
			});
	});
</script>

<svelte:head>
	<title>Devinyl — Daily</title>
</svelte:head>

{#snippet dailyBanner()}
	{#if daily}
		<div class="daily-banner">
			<p class="eyebrow">Devinyl #{daily.dayNumber}</p>
			<h1>Today's quiz</h1>
			{#if daily.alreadyPlayed}
				<p class="muted">
					You've already posted a scored run today — this replay won't count again.
				</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#if error}
	<main class="sheet">
		<p class="error-note">{error.message}</p>
	</main>
{:else if !daily}
	<main class="sheet">
		<p class="waiting">Loading today's quiz…</p>
	</main>
{:else}
	<PlayQuiz target={{ daily: true }} banner={dailyBanner} dailyDayNumber={daily.dayNumber} />
{/if}

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.daily-banner {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
	}

	.daily-banner h1 {
		margin: 0;
	}

	.daily-banner .eyebrow {
		margin: 0;
		font-size: var(--text-micro);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.error-note {
		margin: 0;
		padding: var(--space-3);
		background: var(--negative-soft);
		border-left: 3px solid var(--negative);
		border-radius: var(--radius-sm);
	}

	.waiting {
		color: var(--ink-muted);
	}
</style>
