<script lang="ts">
	/**
	 * The two ARIA live regions behind `Announcer` (A11Y-2/3, see
	 * `$lib/client/a11y.svelte.ts` for the queueing policy this renders).
	 *
	 * Both regions are always mounted, even when empty — a region created
	 * and written to in the same tick is not reliably picked up by
	 * assistive tech, which needs to already know the node exists before it
	 * starts caring about mutations to it. So this component lives once at
	 * the play-flow root and is never conditionally rendered.
	 *
	 * `aria-atomic="true"`: announcements here are short, self-contained
	 * sentences (see the `Announcement.text` callers build), not incremental
	 * diffs, so the whole region should always be re-read rather than just
	 * the changed part.
	 */
	import type { Announcer } from '$lib/client/a11y.svelte.js';

	let { announcer }: { announcer: Announcer } = $props();
</script>

<div class="visually-hidden" aria-live="assertive" aria-atomic="true">{announcer.assertive}</div>
<div class="visually-hidden" aria-live="polite" aria-atomic="true">{announcer.polite}</div>

<style>
	/*
	 * Standard clip-rect visually-hidden pattern — deliberately NOT
	 * `display:none`/`visibility:hidden`, both of which remove the element
	 * from the accessibility tree and would make the live regions invisible
	 * to screen readers too, not just sighted users.
	 */
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
