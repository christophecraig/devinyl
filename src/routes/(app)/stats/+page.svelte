<script lang="ts">
	/**
	 * Personal stats — STAT-1, plan task 3.9. Client-fetched (auth-gated data,
	 * no unfurl need) — same pattern as `/daily`.
	 */
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import { formatNumber } from '$lib/client/intl.js';

	interface PersonalStats {
		gamesPlayed: number;
		averageScore: number;
		bestScore: number;
		streaks: { current: number; best: number };
		modeBreakdown: { speed: number; fixed: number };
		topGenres: { genre: string; count: number }[];
		topDecades: { decade: number; count: number }[];
		bestWeeklyRank: { week: string; rank: number } | null;
	}

	let stats = $state<PersonalStats | null>(null);
	let unauthorized = $state(false);

	onMount(() => {
		fetch('/api/me/stats')
			.then((res) => {
				if (!res.ok) throw new Error('unauthorized');
				return res.json() as Promise<{ stats: PersonalStats }>;
			})
			.then((res) => {
				stats = res.stats;
			})
			.catch(() => {
				unauthorized = true;
			});
	});
</script>

<svelte:head>
	<title>{m.title_stats()}</title>
</svelte:head>

<main class="sheet">
	<h1>{m.stats_heading()}</h1>

	{#if unauthorized}
		<p class="error-note">
			<a href={resolve('/(app)/login')}>{m.stats_signin_prompt()}</a>
			{m.stats_signin_suffix()}
		</p>
	{:else if !stats}
		<p class="waiting">{m.common_loading()}</p>
	{:else}
		<div class="stat-grid">
			<div class="stat-tile">
				<p class="stat-value">{formatNumber(stats.gamesPlayed)}</p>
				<p class="stat-label">{m.stats_games_played()}</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{formatNumber(stats.averageScore)}</p>
				<p class="stat-label">{m.stats_average_score()}</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{formatNumber(stats.bestScore)}</p>
				<p class="stat-label">{m.stats_best_score()}</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{formatNumber(stats.streaks.current)}</p>
				<p class="stat-label">{m.stats_current_streak()}</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{formatNumber(stats.streaks.best)}</p>
				<p class="stat-label">{m.stats_best_streak()}</p>
			</div>
			{#if stats.bestWeeklyRank}
				<div class="stat-tile">
					<p class="stat-value">#{stats.bestWeeklyRank.rank}</p>
					<p class="stat-label">
						{m.stats_best_weekly_rank({ week: stats.bestWeeklyRank.week })}
					</p>
				</div>
			{/if}
		</div>

		<section>
			<h2>{m.stats_mode_breakdown_heading()}</h2>
			<p class="muted">
				{m.stats_mode_breakdown({
					speed: formatNumber(stats.modeBreakdown.speed),
					fixed: formatNumber(stats.modeBreakdown.fixed)
				})}
			</p>
		</section>

		{#if stats.topGenres.length > 0}
			<section>
				<h2>{m.stats_top_genres_heading()}</h2>
				<ul class="rank-list">
					{#each stats.topGenres as g (g.genre)}
						<li>{g.genre} <span class="muted">({formatNumber(g.count)})</span></li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if stats.topDecades.length > 0}
			<section>
				<h2>{m.stats_top_decades_heading()}</h2>
				<ul class="rank-list">
					{#each stats.topDecades as d (d.decade)}
						<li>{d.decade}s <span class="muted">({formatNumber(d.count)})</span></li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
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

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-3);
	}

	.stat-tile {
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
	}

	.stat-value {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--text-title);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--accent-ink);
	}

	.stat-label {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	.rank-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
</style>
