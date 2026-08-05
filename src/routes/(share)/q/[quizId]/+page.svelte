<script lang="ts">
	/** Quiz lobby — SHARE-1/2, plan task 3.14. */
	import PlayQuiz from '$lib/components/PlayQuiz.svelte';
	import type { PageProps } from './$types';

	const { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Devinyl — {data.quizName}</title>
	<meta
		name="description"
		content="A {data.roundCount}-round Devinyl quiz. Guess the song, race the clock."
	/>
	<!-- SHARE-4: branded preview only — never track artwork, titles, or artists. -->
	<meta property="og:title" content={data.quizName} />
	<meta property="og:description" content="A {data.roundCount}-round Devinyl quiz." />
	<meta property="og:image" content="/og-branded.png" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#snippet lobbyBanner()}
	<div class="lobby-banner">
		<p class="eyebrow">Quiz · {data.roundCount} rounds</p>
		<h1>{data.quizName}</h1>
		{#if data.description}<p class="muted">{data.description}</p>{/if}
	</div>
{/snippet}

<PlayQuiz target={{ quizId: data.quizId }} banner={lobbyBanner} />

<style>
	.lobby-banner {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
	}

	.lobby-banner h1 {
		margin: 0;
	}

	.lobby-banner .eyebrow {
		margin: 0;
		font-size: var(--text-micro);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.lobby-banner .muted {
		margin: 0;
	}
</style>
