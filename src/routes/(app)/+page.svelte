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
	import { MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS } from '$lib/game/types.js';
	import type { AnswerMode, GuessTarget } from '$lib/game/types.js';

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
				settings: { guessTarget, answerMode }
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

<main>
	<h1>Devinyl</h1>
	<p class="tagline">A French-repertoire music blind test.</p>

	{#if mounted}
		{#if nickname === null}
			<section aria-labelledby="nickname-heading">
				<h2 id="nickname-heading">Pick a nickname to play</h2>
				<NicknamePrompt onsubmit={handleNicknameSubmit} />
			</section>
		{:else}
			<section aria-labelledby="generate-heading">
				<h2 id="generate-heading">Playing as {nickname}</h2>
				<form onsubmit={handleSubmit}>
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

					<div class="field">
						<label for="rounds">Rounds ({rounds})</label>
						<input id="rounds" type="range" min={MIN_ROUNDS} max={MAX_ROUNDS} bind:value={rounds} />
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

					<p class="error" role="alert">{formError ?? ''}</p>
					{#if apiError}
						<p class="error" role="alert">{apiError.message}</p>
					{/if}

					<button type="submit" disabled={submitting}>
						{submitting ? 'Generating…' : 'Generate quiz'}
					</button>
				</form>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 30rem;
		margin: 0 auto;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.tagline {
		margin: -1rem 0 0;
		opacity: 0.8;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	label {
		font-weight: 600;
	}

	input,
	select {
		padding: 0.5rem;
		font-size: 1rem;
		border: 1px solid;
		border-radius: 0.25rem;
	}

	.error {
		min-height: 1.2em;
		margin: 0;
		font-size: 0.875rem;
		color: #c0392b;
	}

	button {
		align-self: flex-start;
		padding: 0.6rem 1.25rem;
		font-size: 1rem;
		cursor: pointer;
	}
</style>
