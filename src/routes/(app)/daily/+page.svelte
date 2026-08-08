<script lang="ts">
	/**
	 * Daily quiz — DAILY-1/2/5, plan task 3.1. Client-fetched like `/play`
	 * (no unfurl requirement here, unlike the challenge lobby — task 3.14
	 * only asks for OG meta on `/q/`, `/c/`, `/i/`).
	 */
	import { onMount } from 'svelte';
	import PlayQuiz from '$lib/components/PlayQuiz.svelte';
	import { getDaily, ApiError, type DailyInfo } from '$lib/client/api.js';
	import { m } from '$lib/paraglide/messages.js';
	import { localizeApiErrorCode } from '$lib/client/errors.js';

	let daily = $state<DailyInfo | null>(null);
	let error = $state<ApiError | null>(null);

	onMount(() => {
		getDaily()
			.then((d) => {
				daily = d;
			})
			.catch((err: unknown) => {
				error =
					err instanceof ApiError ? err : new ApiError(0, 'network_error', m.home_error_network());
			});
	});
</script>

<svelte:head>
	<title>{m.title_daily()}</title>
</svelte:head>

{#snippet dailyBanner()}
	{#if daily}
		<div class="daily-banner">
			<p class="eyebrow">{m.daily_eyebrow({ day: daily.dayNumber })}</p>
			<h1>{m.daily_heading()}</h1>
			{#if daily.alreadyPlayed}
				<p class="muted">
					{m.daily_already_played()}
				</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#if error}
	<main class="sheet">
		<h1>{m.daily_heading()}</h1>
		{#if error.code === 'not_found'}
			<!-- Not an error state: `GET /api/daily` 404s a day with no scheduled
			     quiz, and that is a state the product produces on its own — task
			     4.2's availability job *clears* an upcoming daily slot when one of
			     its tracks is taken down. Showing the generic error string here
			     would read as a fault when the honest answer is "nothing today". -->
			<p class="waiting">{m.daily_none_today()}</p>
		{:else}
			<p class="error-note">{localizeApiErrorCode(error.code)}</p>
		{/if}
	</main>
{:else if !daily}
	<main class="sheet">
		<h1>{m.daily_heading()}</h1>
		<p class="waiting">{m.daily_loading()}</p>
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
