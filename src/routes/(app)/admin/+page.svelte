<script lang="ts">
	/**
	 * `/admin` dashboard — §15, plan tasks 2.9/3.11.
	 *
	 * Operator-gated client-side by probing an operator-only endpoint: every
	 * request below 403s for a non-operator anyway (the server is the real
	 * gate, `requireOperator`), so this page just decides what to render, not
	 * what to allow. Three sections, each backed by an API that already
	 * shipped without a screen (2.9's daily calendar + flagged sessions,
	 * 3.11's metrics aggregation) — this is that screen, for all three.
	 */
	import { onMount } from 'svelte';

	interface DailyCalendarEntry {
		day: string;
		quizId: string | null;
		quizName: string | null;
		dayNumber: number | null;
	}
	interface FlaggedSession {
		id: string;
		quizId: string;
		quizName: string;
		nickname: string;
		scoredBlockReason: string;
		finalizedAt: number | null;
	}
	interface MetricsDay {
		day: string;
		metrics: Record<string, number>;
	}

	let authorized = $state<boolean | null>(null);
	let calendar = $state<DailyCalendarEntry[]>([]);
	let flagged = $state<FlaggedSession[]>([]);
	let series = $state<MetricsDay[]>([]);

	async function fetchJson<T>(path: string): Promise<T> {
		const res = await fetch(path);
		if (!res.ok) throw new Error(String(res.status));
		return res.json() as Promise<T>;
	}

	onMount(async () => {
		try {
			const [dailyRes, flaggedRes, metricsRes] = await Promise.all([
				fetchJson<{ calendar: DailyCalendarEntry[] }>('/api/admin/daily'),
				fetchJson<{ sessions: FlaggedSession[] }>('/api/admin/flagged-sessions'),
				fetchJson<{ series: MetricsDay[] }>('/api/admin/metrics?days=30')
			]);
			calendar = dailyRes.calendar;
			flagged = flaggedRes.sessions;
			series = metricsRes.series;
			authorized = true;
		} catch {
			authorized = false;
		}
	});

	function sum(metric: string): number {
		return series.reduce((total, s) => total + (s.metrics[metric] ?? 0), 0);
	}

	const d7CohortTotal = $derived(sum('d7_cohort'));
	const d7ReturnTotal = $derived(sum('d7_return'));
	const d7Rate = $derived(
		d7CohortTotal > 0 ? Math.round((100 * d7ReturnTotal) / d7CohortTotal) : null
	);

	const STREAK_BUCKETS = ['0', '1', '2', '3', '4', '5plus'] as const;

	/**
	 * MET-2's "median streak among returning players" doesn't have a direct
	 * metric column — approximated here from the streak-length histogram
	 * (bucketed 0/1/2/3/4/5+ among everyone who played the daily, not only
	 * returners, since that's what `metrics.ts` actually records). Flagged as
	 * an approximation in the label rather than silently treated as exact.
	 */
	const streakMedian = $derived.by(() => {
		const counts = STREAK_BUCKETS.map((b) => ({ bucket: b, n: sum(`streak_${b}`) }));
		const total = counts.reduce((t, c) => t + c.n, 0);
		if (total === 0) return null;
		let seen = 0;
		for (const c of counts) {
			seen += c.n;
			if (seen >= total / 2) return c.bucket;
		}
		return counts[counts.length - 1].bucket;
	});
</script>

<svelte:head>
	<title>Devinyl — Admin</title>
</svelte:head>

<main class="sheet">
	<h1>Admin</h1>

	{#if authorized === null}
		<p class="waiting">Loading…</p>
	{:else if authorized === false}
		<p class="error-note">Operator access required.</p>
	{:else}
		<section>
			<h2>MET-2 targets</h2>
			<div class="stat-grid">
				<div class="stat-tile" class:hit={d7Rate !== null && d7Rate >= 25}>
					<p class="stat-value">{d7Rate === null ? '—' : `${d7Rate}%`}</p>
					<p class="stat-label">D7 return (target ≥ 25%)</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{streakMedian === null ? '—' : streakMedian}</p>
					<p class="stat-label">Approx. median streak (target ≥ 3)</p>
				</div>
			</div>
		</section>

		<section>
			<h2>Funnel (last 30 days)</h2>
			<div class="stat-grid">
				<div class="stat-tile">
					<p class="stat-value">{sum('daily_started')}</p>
					<p class="stat-label">Daily started</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{sum('daily_completed')}</p>
					<p class="stat-label">Daily completed</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{sum('daily_shared')}</p>
					<p class="stat-label">Daily shared</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{sum('challenge_opened')}</p>
					<p class="stat-label">Challenges opened</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{sum('challenge_started')}</p>
					<p class="stat-label">Challenges played</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{sum('challenge_completed')}</p>
					<p class="stat-label">Challenges completed</p>
				</div>
				<div class="stat-tile">
					<p class="stat-value">{sum('guest_account_conversion')}</p>
					<p class="stat-label">Guest → account</p>
				</div>
			</div>
		</section>

		<section>
			<h2>Daily calendar (next 14 days)</h2>
			<ul class="rank-list">
				{#each calendar as entry (entry.day)}
					<li class:gap={entry.quizId === null}>
						{entry.day}
						{#if entry.quizId}
							— #{entry.dayNumber} {entry.quizName}
						{:else}
							— <strong>gap, no quiz scheduled</strong>
						{/if}
					</li>
				{/each}
			</ul>
		</section>

		<section>
			<h2>Flagged sessions</h2>
			{#if flagged.length === 0}
				<p class="muted">Nothing flagged.</p>
			{:else}
				<ul class="rank-list">
					{#each flagged as s (s.id)}
						<li>{s.nickname} · {s.quizName} · {s.scoredBlockReason}</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.waiting {
		color: var(--ink-muted);
	}

	.error-note {
		margin: 0;
		padding: var(--space-3);
		background: var(--negative-soft);
		border-left: 3px solid var(--negative);
		border-radius: var(--radius-sm);
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: var(--space-3);
	}

	.stat-tile {
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
	}

	.stat-tile.hit {
		border-color: var(--accent);
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
		font-size: var(--text-small);
	}

	.rank-list li.gap {
		color: var(--negative);
	}
</style>
