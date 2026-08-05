<script lang="ts">
	/**
	 * Spoiler-free daily result share — DAILY-3, plan task 3.10. Text comes
	 * from `$lib/game/share.ts` (pure, unit-tested) — this component is only
	 * the Share API/clipboard wiring and the MET-1 share-click counter.
	 */
	import { buildDailyShareText } from '$lib/game/share.js';
	import { recordMetricEvent } from '$lib/client/api.js';
	import type { FinalizedRound } from '$lib/game/types.js';

	interface Props {
		dayNumber: number;
		totalScore: number;
		rounds: Pick<FinalizedRound, 'skipped' | 'titleOk' | 'artistOk'>[];
	}

	const { dayNumber, totalScore, rounds }: Props = $props();

	let copied = $state(false);

	async function share(): Promise<void> {
		const text = buildDailyShareText({ dayNumber, totalScore, rounds, url: location.origin });
		const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
		void recordMetricEvent('daily_share');
		if (nav.share) {
			try {
				await nav.share({ text });
				return;
			} catch {
				// Cancelled — fall through to clipboard so the tap isn't a dead end.
			}
		}
		await navigator.clipboard.writeText(text);
		copied = true;
	}
</script>

<button type="button" onclick={share}>{copied ? 'Copied!' : 'Share result'}</button>
