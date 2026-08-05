<script lang="ts">
	/**
	 * Home — SOLO-1, technical-spec §7.1, plan task 1.28.
	 *
	 * Guest-first entry point: nickname (if unset) → generation filters →
	 * `generateQuiz` → `/play/:quizId`. No account, no server round-trip
	 * before the player has something to click.
	 *
	 * Guest identity lives in `localStorage`, which doesn't exist during SSR —
	 * `mounted` gates the nickname-dependent branch so the server-rendered
	 * markup and the first client render agree (no hydration mismatch), per
	 * the same pattern the play route uses.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import NicknamePrompt from '$lib/components/NicknamePrompt.svelte';
	import { loadGuest, setNickname } from '$lib/client/guest.js';
	import { generateQuiz, ApiError } from '$lib/client/api.js';
	import {
		MIN_ROUNDS,
		MAX_ROUNDS,
		DEFAULT_ROUNDS,
		MIN_CHOICE_RETRY_PENALTY_SECONDS,
		MAX_CHOICE_RETRY_PENALTY_SECONDS,
		DEFAULT_CHOICE_RETRY_PENALTY_SECONDS
	} from '$lib/game/types.js';
	import type { AnswerMode, ChoiceRetryMode, GuessTarget } from '$lib/game/types.js';

	let mounted = $state(false);
	let nickname = $state<string | null>(null);

	onMount(() => {
		nickname = loadGuest().nickname;
		mounted = true;
	});

	function handleNicknameSubmit(name: string): void {
		setNickname(name);
		nickname = name;
	}

	// Generation filters (CREATE-5, scoped to structured filters per plan §G-8 —
	// no open free-text theme field in v1).
	let decade = $state<string>('');
	let genre = $state('');
	let artist = $state('');
	let rounds = $state(DEFAULT_ROUNDS);
	let guessTarget = $state<GuessTarget>('both');
	let answerMode = $state<AnswerMode>('text');
	/** QUIZ-7 — only sent/relevant when `answerMode === 'choice'`. */
	let choiceRetryMode = $state<ChoiceRetryMode>('oneShot');
	let choiceRetryPenaltySeconds = $state(DEFAULT_CHOICE_RETRY_PENALTY_SECONDS);

	let formError = $state<string | null>(null);
	let submitting = $state(false);
	let apiError = $state<ApiError | null>(null);

	const DECADE_OPTIONS = Array.from({ length: 8 }, (_, i) => 1950 + i * 10);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		formError = null;
		apiError = null;

		if (!decade && !genre.trim() && !artist.trim()) {
			formError = 'Pick a decade, a genre, or an artist to build the quiz from.';
			return;
		}

		submitting = true;
		try {
			const { quizId } = await generateQuiz({
				decade: decade ? Number(decade) : undefined,
				genre: genre.trim() || undefined,
				artist: artist.trim() || undefined,
				rounds,
				settings: {
					guessTarget,
					answerMode,
					...(answerMode === 'choice' ? { choiceRetryMode, choiceRetryPenaltySeconds } : {})
				}
			});
			await goto(resolve('/(app)/play/[quizId]', { quizId }));
		} catch (err) {
			apiError = err instanceof ApiError ? err : new ApiError(0, 'network_error', 'Network error.');
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Devinyl</title>
</svelte:head>

<main class="sheet">
	<div class="hero">
		<p class="eyebrow">French repertoire · Blind test</p>
		<h1>Name the track<br />before the clip runs out.</h1>
		<p class="tagline">
			Pick a decade, a genre or an artist. We'll cut ten clips and start the clock — the faster you
			lock it in, the more it's worth.
		</p>
	</div>

	{#if mounted}
		{#if nickname === null}
			<section class="panel" aria-labelledby="nickname-heading">
				<h2 id="nickname-heading">Pick a nickname to play</h2>
				<p class="panel-note">No account, no email. It's just what the scoreboard calls you.</p>
				<NicknamePrompt onsubmit={handleNicknameSubmit} />
			</section>
		{:else}
			<section class="panel" aria-labelledby="generate-heading">
				<h2 id="generate-heading">Playing as {nickname}</h2>
				<hr class="rule" />

				<form onsubmit={handleSubmit}>
					<p class="group-label">Build the quiz from</p>
					<div class="field">
						<label for="decade">Decade</label>
						<select id="decade" bind:value={decade}>
							<option value="">Any</option>
							{#each DECADE_OPTIONS as d (d)}
								<option value={d}>{d}s</option>
							{/each}
						</select>
					</div>

					<div class="field">
						<label for="genre">Genre</label>
						<input id="genre" type="text" bind:value={genre} placeholder="e.g. chanson, rap" />
					</div>

					<div class="field">
						<label for="artist">Artist</label>
						<input id="artist" type="text" bind:value={artist} placeholder="e.g. Stromae" />
					</div>

					<hr class="rule" />
					<p class="group-label">How it plays</p>

					<div class="field">
						<label for="rounds">Rounds ({rounds})</label>
						<input id="rounds" type="range" min={MIN_ROUNDS} max={MAX_ROUNDS} bind:value={rounds} />
						<div class="range-scale" aria-hidden="true">
							<span>{MIN_ROUNDS}</span><span>{MAX_ROUNDS}</span>
						</div>
					</div>

					<div class="field">
						<label for="guessTarget">Guess</label>
						<select id="guessTarget" bind:value={guessTarget}>
							<option value="both">Title & artist</option>
							<option value="title">Title only</option>
							<option value="artist">Artist only</option>
						</select>
					</div>

					<div class="field">
						<label for="answerMode">Answer style</label>
						<select id="answerMode" bind:value={answerMode}>
							<option value="text">Type the answer</option>
							<option value="choice">Multiple choice</option>
						</select>
					</div>

					{#if answerMode === 'choice'}
						<div class="field">
							<label for="choiceRetryMode">If you pick wrong</label>
							<select id="choiceRetryMode" bind:value={choiceRetryMode}>
								<option value="oneShot">Lock in immediately — one shot</option>
								<option value="penalty">Wait, then try again</option>
							</select>
						</div>

						{#if choiceRetryMode === 'penalty'}
							<div class="field">
								<label for="choiceRetryPenaltySeconds">
									Retry wait ({choiceRetryPenaltySeconds}s)
								</label>
								<input
									id="choiceRetryPenaltySeconds"
									type="range"
									min={MIN_CHOICE_RETRY_PENALTY_SECONDS}
									max={MAX_CHOICE_RETRY_PENALTY_SECONDS}
									bind:value={choiceRetryPenaltySeconds}
								/>
								<div class="range-scale" aria-hidden="true">
									<span>{MIN_CHOICE_RETRY_PENALTY_SECONDS}s</span>
									<span>{MAX_CHOICE_RETRY_PENALTY_SECONDS}s</span>
								</div>
							</div>
						{/if}
					{/if}

					<p class="error" role="alert">{formError ?? ''}</p>
					{#if apiError}
						<p class="error" role="alert">{apiError.message}</p>
					{/if}

					<button class="primary start" type="submit" disabled={submitting}>
						{submitting ? 'Generating…' : 'Generate quiz'}
					</button>
				</form>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding-top: var(--space-4);
		animation: rise var(--dur-slow) var(--ease) both;
	}

	.hero h1 {
		font-size: var(--text-hero);
	}

	.tagline {
		margin: 0;
		max-width: 28rem;
		color: var(--ink-muted);
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
		padding: var(--space-5) var(--space-4);
		animation: rise var(--dur-slow) var(--ease) both;
		animation-delay: 80ms;
	}

	.panel-note {
		margin: calc(var(--space-3) * -1) 0 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	/* Sub-heads inside the form, not headings: they group controls visually
	   without adding levels to the outline between <h2> and the labels. */
	.group-label {
		margin: 0;
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.range-scale {
		display: flex;
		justify-content: space-between;
		font-size: var(--text-micro);
		color: var(--ink-faint);
		font-variant-numeric: tabular-nums;
	}

	.error {
		min-height: 1.2em;
		margin: 0;
		font-size: var(--text-small);
		color: var(--negative);
	}

	.start {
		align-self: stretch;
		margin-top: var(--space-1);
		font-size: var(--text-body);
		padding-block: var(--space-4);
	}
</style>
