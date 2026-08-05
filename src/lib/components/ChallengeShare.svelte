<script lang="ts">
	/**
	 * "Challenge a friend" — CHAL-1, plan task 3.10. Creates the challenge
	 * link on demand (not eagerly — most finished runs never get shared) and
	 * hands it to the Share API where available, clipboard otherwise.
	 */
	import { createChallenge, ApiError } from '$lib/client/api.js';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		sessionId: string;
		nickname: string;
		scoreToBeat: number;
	}

	const { sessionId, nickname, scoreToBeat }: Props = $props();

	let phase = $state<'idle' | 'creating' | 'ready' | 'error'>('idle');
	let url = $state('');
	let copied = $state(false);

	async function createLink(): Promise<void> {
		phase = 'creating';
		try {
			const { token } = await createChallenge(sessionId);
			url = `${location.origin}${resolve('/(share)/c/[token]', { token })}`;
			phase = 'ready';
		} catch (err: unknown) {
			phase = 'error';
			void (err instanceof ApiError ? err.message : 'error');
		}
	}

	async function share(): Promise<void> {
		const text = m.share_challenge_text({ name: nickname, score: scoreToBeat });
		const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
		if (nav.share) {
			try {
				await nav.share({ text, url });
				return;
			} catch {
				// User cancelled the native share sheet — fall through to clipboard.
			}
		}
		await navigator.clipboard.writeText(`${text}\n${url}`);
		copied = true;
	}
</script>

{#if phase === 'idle'}
	<button type="button" onclick={createLink}>{m.challenge_share_button()}</button>
{:else if phase === 'creating'}
	<button type="button" disabled>{m.challenge_share_creating()}</button>
{:else if phase === 'error'}
	<button type="button" onclick={createLink}>{m.challenge_share_retry()}</button>
{:else}
	<div class="challenge-ready">
		<button type="button" onclick={share}
			>{copied ? m.daily_share_copied() : m.challenge_share_link_button()}</button
		>
		<input
			class="link-field"
			type="text"
			readonly
			value={url}
			aria-label={m.challenge_share_link_label()}
		/>
	</div>
{/if}

<style>
	.challenge-ready {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
	}

	.link-field {
		flex: 1;
		min-width: 12rem;
		font-size: var(--text-small);
		padding: var(--space-2);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		color: var(--ink-muted);
	}
</style>
