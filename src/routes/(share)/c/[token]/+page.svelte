<script lang="ts">
	/**
	 * Challenge lobby — CHAL-1/2/3, plan task 3.5. Playable straight from the
	 * browser, no account: `PlayQuiz` already treats a guest as first-class.
	 */
	import PlayQuiz from '$lib/components/PlayQuiz.svelte';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages.js';
	import { formatNumber } from '$lib/client/intl.js';

	const { data }: PageProps = $props();
	const lobby = $derived(data.lobby);
</script>

<svelte:head>
	<title>{m.title_challenge_lobby({ name: lobby.challengerName })}</title>
	<meta
		name="description"
		content={m.challenge_lobby_description({
			name: lobby.challengerName,
			score: lobby.scoreToBeat
		})}
	/>
	<!-- SHARE-4: nickname + score to beat only — never track names, artwork, or titles. -->
	<meta property="og:title" content={m.challenge_lobby_og_title({ name: lobby.challengerName })} />
	<meta
		property="og:description"
		content={m.challenge_lobby_og_description({ score: lobby.scoreToBeat, rounds: lobby.rounds })}
	/>
	<meta property="og:image" content="/og-branded.png" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#snippet lobbyBanner()}
	<div class="lobby-banner">
		<p class="eyebrow">{m.challenge_lobby_eyebrow()}</p>
		<h1>{m.challenge_lobby_heading({ name: lobby.challengerName })}</h1>
		<p class="muted">
			{m.challenge_lobby_score_to_beat()}
			<strong>{m.play_score_pts({ score: formatNumber(lobby.scoreToBeat) })}</strong>
			· {m.challenge_lobby_rounds({ count: lobby.rounds })}
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
