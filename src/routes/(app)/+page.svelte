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
	import { m } from '$lib/paraglide/messages.js';
	import { localizeApiErrorCode } from '$lib/client/errors.js';

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
			formError = m.home_error_no_filters();
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
			apiError =
				err instanceof ApiError ? err : new ApiError(0, 'network_error', m.home_error_network());
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
		<p class="eyebrow">{m.home_eyebrow()}</p>
		<h1>{m.home_h1_line1()}<br />{m.home_h1_line2()}</h1>
		<p class="tagline">
			{m.home_tagline()}
		</p>
	</div>

	{#if mounted}
		{#if nickname === null}
			<section class="panel" aria-labelledby="nickname-heading">
				<h2 id="nickname-heading">{m.home_nickname_heading()}</h2>
				<p class="panel-note">{m.home_nickname_note()}</p>
				<NicknamePrompt onsubmit={handleNicknameSubmit} />
			</section>
		{:else}
			<section class="panel" aria-labelledby="generate-heading">
				<h2 id="generate-heading">{m.home_playing_as({ nickname })}</h2>
				<hr class="rule" />

				<form onsubmit={handleSubmit}>
					<p class="group-label">{m.home_group_build()}</p>
					<div class="field">
						<label for="decade">{m.home_label_decade()}</label>
						<select id="decade" bind:value={decade}>
							<option value="">{m.home_option_any()}</option>
							{#each DECADE_OPTIONS as d (d)}
								<option value={d}>{d}s</option>
							{/each}
						</select>
					</div>

					<div class="field">
						<label for="genre">{m.home_label_genre()}</label>
						<input
							id="genre"
							type="text"
							bind:value={genre}
							placeholder={m.home_placeholder_genre()}
						/>
					</div>

					<div class="field">
						<label for="artist">{m.home_label_artist()}</label>
						<input
							id="artist"
							type="text"
							bind:value={artist}
							placeholder={m.home_placeholder_artist()}
						/>
					</div>

					<hr class="rule" />
					<p class="group-label">{m.home_group_how_it_plays()}</p>

					<div class="field">
						<label for="rounds">{m.home_label_rounds({ rounds })}</label>
						<input id="rounds" type="range" min={MIN_ROUNDS} max={MAX_ROUNDS} bind:value={rounds} />
						<div class="range-scale" aria-hidden="true">
							<span>{MIN_ROUNDS}</span><span>{MAX_ROUNDS}</span>
						</div>
					</div>

					<div class="field">
						<label for="guessTarget">{m.home_label_guess()}</label>
						<select id="guessTarget" bind:value={guessTarget}>
							<option value="both">{m.home_option_guess_both()}</option>
							<option value="title">{m.home_option_guess_title()}</option>
							<option value="artist">{m.home_option_guess_artist()}</option>
						</select>
					</div>

					<div class="field">
						<label for="answerMode">{m.home_label_answer_mode()}</label>
						<select id="answerMode" bind:value={answerMode}>
							<option value="text">{m.home_option_answer_text()}</option>
							<option value="choice">{m.home_option_answer_choice()}</option>
						</select>
					</div>

					{#if answerMode === 'choice'}
						<div class="field">
							<label for="choiceRetryMode">{m.home_label_retry_mode()}</label>
							<select id="choiceRetryMode" bind:value={choiceRetryMode}>
								<option value="oneShot">{m.home_option_retry_oneshot()}</option>
								<option value="penalty">{m.home_option_retry_penalty()}</option>
							</select>
						</div>

						{#if choiceRetryMode === 'penalty'}
							<div class="field">
								<label for="choiceRetryPenaltySeconds">
									{m.home_label_retry_wait({ seconds: choiceRetryPenaltySeconds })}
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
						<p class="error" role="alert">{localizeApiErrorCode(apiError.code)}</p>
					{/if}

					<button class="primary start" type="submit" disabled={submitting}>
						{submitting ? m.home_button_generating() : m.home_button_generate()}
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
