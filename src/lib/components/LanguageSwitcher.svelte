<script lang="ts">
	/**
	 * LOC-1 settings switcher: writes the `PARAGLIDE_LOCALE` cookie via
	 * `setLocale`, which the `cookie` strategy (vite.config.ts) then reads
	 * first on every subsequent request, ahead of `Accept-Language`.
	 * `setLocale` reloads the document by default — the simplest way to get a
	 * fully re-rendered (and re-localized) SSR page.
	 */
	import { getLocale, setLocale, locales, type Locale } from '$lib/paraglide/runtime.js';
	import { m } from '$lib/paraglide/messages.js';

	const labels: Record<Locale, string> = { en: 'English', fr: 'Français' };
</script>

<div class="switcher" role="group" aria-label={m.nav_language_label()}>
	{#each locales as locale (locale)}
		<button
			type="button"
			class="option"
			aria-pressed={getLocale() === locale}
			disabled={getLocale() === locale}
			onclick={() => setLocale(locale)}
		>
			{labels[locale]}
		</button>
	{/each}
</div>

<style>
	.switcher {
		display: flex;
		gap: var(--space-2);
	}

	.option {
		font: inherit;
		font-size: var(--text-small);
		color: var(--ink-muted);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}

	.option[aria-pressed='true'] {
		color: var(--accent-ink);
		font-weight: 600;
		cursor: default;
	}

	.option:not([aria-pressed='true']):hover {
		color: var(--accent-ink);
	}
</style>
