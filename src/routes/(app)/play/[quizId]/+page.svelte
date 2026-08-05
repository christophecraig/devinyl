<script lang="ts">
	/**
	 * Solo/link play — SOLO-1/2, CREATE-*, plan task 1.28. Thin: all the
	 * actual game wiring lives in `PlayQuiz.svelte` (extracted at task 3.5 so
	 * `(share)/c/[token]` and `/daily` can reuse it verbatim).
	 */
	import { page } from '$app/state';
	import PlayQuiz from '$lib/components/PlayQuiz.svelte';
	import { m } from '$lib/paraglide/messages.js';

	const quizId = page.params.quizId as string;
</script>

<svelte:head>
	<title>{m.title_play()}</title>
</svelte:head>

<PlayQuiz target={{ quizId }} />
