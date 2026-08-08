<script lang="ts">
	/**
	 * Terms of Service — LEGAL-3, plan task 4.5. Same rendering approach as
	 * `../privacy/+page.svelte`: FR (authoritative) or EN (translation) prose
	 * from `./content.ts`, chosen at runtime via Paraglide's `getLocale()`.
	 */
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { formatDate } from '$lib/client/intl.js';
	import { fr, en, CONTACT_EMAIL, LAST_UPDATED } from './content';

	const content = $derived(getLocale() === 'fr' ? fr : en);
	const lastUpdated = $derived(
		formatDate(new Date(`${LAST_UPDATED}T00:00:00Z`), {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			timeZone: 'UTC'
		})
	);
</script>

<svelte:head>
	<title>{content.documentTitle} — Devinyl</title>
</svelte:head>

<main class="sheet legal">
	<h1>{content.documentTitle}</h1>

	<p class="updated">{content.lastUpdatedLabel}: {lastUpdated}</p>

	{#if content.translationNote}
		<p class="translation-note" lang={getLocale() === 'fr' ? 'en' : 'fr'}>
			{content.translationNote}
		</p>
	{/if}

	{#each content.intro as paragraph (paragraph)}
		<p>{paragraph}</p>
	{/each}

	<nav class="toc" aria-label={content.tocLabel}>
		<p class="toc-label">{content.tocLabel}</p>
		<ol>
			{#each content.sections as section (section.id)}
				<li><a href="#{section.id}">{section.heading}</a></li>
			{/each}
			<li><a href="#contact">{content.contactLabel}</a></li>
		</ol>
	</nav>

	{#each content.sections as section (section.id)}
		<section id={section.id}>
			<h2>{section.heading}</h2>
			{#each section.paragraphs as paragraph (paragraph)}
				<p>{paragraph}</p>
			{/each}
			{#if section.list}
				<ul>
					{#each section.list as item (item)}
						<li>{item}</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<section id="contact">
		<h2>{content.contactLabel}</h2>
		<p>
			{content.contactIntro}
			<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>
		</p>
	</section>
</main>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.legal {
		max-width: 42rem;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4);
	}

	.updated {
		margin: 0;
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	.translation-note {
		margin: 0;
		padding: var(--space-3);
		background: var(--surface-sunken);
		border-left: 3px solid var(--rule-strong);
		border-radius: var(--radius-sm);
		font-size: var(--text-small);
		color: var(--ink-muted);
	}

	.toc {
		padding: var(--space-3) var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
	}

	.toc-label {
		margin: 0 0 var(--space-2);
		font-weight: 600;
		color: var(--ink);
	}

	.toc ol {
		margin: 0;
		padding-left: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	h2 {
		font-family: var(--font-display);
		font-size: var(--text-title);
	}

	ul,
	.toc ol {
		font-size: var(--text-body);
	}

	li {
		line-height: 1.5;
	}
</style>
