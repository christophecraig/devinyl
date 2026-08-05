<script lang="ts">
	/**
	 * Challenge lobby — CHAL-1/2/3, plan task 3.5. Playable straight from the
	 * browser, no account: `PlayQuiz` already treats a guest as first-class.
	 */
	import PlayQuiz from '$lib/components/PlayQuiz.svelte';
	import type { PageProps } from './$types';

	const { data }: PageProps = $props();
	const lobby = $derived(data.lobby);
</script>

<svelte:head>
	<title>Devinyl — {lobby.challengerName} challenges you</title>
	<meta
		name="description"
		content="{lobby.challengerName} scored {lobby.scoreToBeat} pts on Devinyl. Beat it?"
	/>
	<!-- SHARE-4: nickname + score to beat only — never track names, artwork, or titles. -->
	<meta property="og:title" content="{lobby.challengerName} challenges you on Devinyl" />
	<meta
		property="og:description"
		content="Score to beat: {lobby.scoreToBeat} pts — {lobby.rounds} rounds."
	/>
	<meta property="og:image" content="/og-branded.png" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#snippet lobbyBanner()}
	<div class="lobby-banner">
		<p class="eyebrow">Challenge</p>
		<h1>{lobby.challengerName} challenges you</h1>
		<p class="muted">
			Score to beat: <strong>{lobby.scoreToBeat} pts</strong> · {lobby.rounds} rounds
		</p>
	</div>
{/snippet}

<PlayQuiz target={{ challengeToken: lobby.token }} banner={lobbyBanner} />

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
