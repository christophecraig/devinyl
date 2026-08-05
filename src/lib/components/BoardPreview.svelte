<script lang="ts">
	/**
	 * "Board next to a friend" — STAT-2/CHAL-2/DAILY-2, plan task 3.10.
	 *
	 * A compact top-N + self-row preview for the end-of-game summary. The
	 * full board with paging/friends-filter is out of scope for the summary
	 * — this exists to answer "how did I do" at a glance, not to replace a
	 * dedicated board page.
	 */
	import { getBoard, ApiError, type BoardScopePath } from '$lib/client/api.js';
	import type { ScoringMode } from '$lib/game/types.js';

	interface Props {
		scope: BoardScopePath;
		mode: ScoringMode;
	}

	const { scope, mode }: Props = $props();

	let loading = $state(true);
	let error = $state(false);
	let entries = $state<{ rank: number; name: string; totalScore: number; isSelf: boolean }[]>([]);
	let selfOutsideTop = $state<{ rank: number; name: string; totalScore: number } | null>(null);

	$effect(() => {
		loading = true;
		error = false;
		getBoard(scope, { mode })
			.then((board) => {
				entries = board.entries.slice(0, 5);
				const selfInTop = board.selfEntry && entries.some((e) => e.isSelf);
				selfOutsideTop = board.selfEntry && !selfInTop ? board.selfEntry : null;
			})
			.catch((err: unknown) => {
				// A board load failing must never block the summary the player
				// already sees (FAIR-6 posture) — just hide the widget.
				error = !(err instanceof ApiError && err.status === 404);
			})
			.finally(() => {
				loading = false;
			});
	});
</script>

{#if loading}
	<p class="muted board-note">Loading the board…</p>
{:else if !error && entries.length > 0}
	<div class="board-preview">
		<h2 class="board-heading">Board</h2>
		<ol class="board-list">
			{#each entries as entry (entry.rank)}
				<li class:self={entry.isSelf}>
					<span class="board-rank">{entry.rank}</span>
					<span class="board-name">{entry.name}</span>
					<span class="board-score">{entry.totalScore}</span>
				</li>
			{/each}
		</ol>
		{#if selfOutsideTop}
			<p class="board-self-row">
				You: #{selfOutsideTop.rank} · {selfOutsideTop.totalScore} pts
			</p>
		{/if}
	</div>
{/if}

<style>
	.board-note {
		font-size: var(--text-small);
	}

	.board-preview {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.board-heading {
		margin: 0;
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.board-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.board-list li {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-1) 0;
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}

	.board-list li.self {
		font-weight: 600;
		color: var(--accent-ink);
	}

	.board-rank {
		width: 1.5rem;
		color: var(--ink-faint);
	}

	.board-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.board-self-row {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}
</style>
