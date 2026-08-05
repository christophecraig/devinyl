<script lang="ts">
	/**
	 * Personal stats — STAT-1, plan task 3.9. Client-fetched (auth-gated data,
	 * no unfurl need) — same pattern as `/daily`.
	 */
	import { onMount } from 'svelte';

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
	let error = $state<string | null>(null);

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
				error = 'Sign in to see your stats.';
			});
	});
</script>

<svelte:head>
	<title>Devinyl — Your stats</title>
</svelte:head>

<main class="sheet">
	<h1>Your stats</h1>

	{#if error}
		<p class="error-note">{error}</p>
	{:else if !stats}
		<p class="waiting">Loading…</p>
	{:else}
		<div class="stat-grid">
			<div class="stat-tile">
				<p class="stat-value">{stats.gamesPlayed}</p>
				<p class="stat-label">Games played</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{stats.averageScore}</p>
				<p class="stat-label">Average score</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{stats.bestScore}</p>
				<p class="stat-label">Best score</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{stats.streaks.current}</p>
				<p class="stat-label">Current streak</p>
			</div>
			<div class="stat-tile">
				<p class="stat-value">{stats.streaks.best}</p>
				<p class="stat-label">Best streak</p>
			</div>
			{#if stats.bestWeeklyRank}
				<div class="stat-tile">
					<p class="stat-value">#{stats.bestWeeklyRank.rank}</p>
					<p class="stat-label">Best weekly rank ({stats.bestWeeklyRank.week})</p>
				</div>
			{/if}
		</div>

		<section>
			<h2>Mode breakdown</h2>
			<p class="muted">Speed: {stats.modeBreakdown.speed} · Untimed: {stats.modeBreakdown.fixed}</p>
		</section>

		{#if stats.topGenres.length > 0}
			<section>
				<h2>Top genres</h2>
				<ul class="rank-list">
					{#each stats.topGenres as g (g.genre)}
						<li>{g.genre} <span class="muted">({g.count})</span></li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if stats.topDecades.length > 0}
			<section>
				<h2>Top decades</h2>
				<ul class="rank-list">
					{#each stats.topDecades as d (d.decade)}
						<li>{d.decade}s <span class="muted">({d.count})</span></li>
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
