<script lang="ts">
	/**
	 * App shell — the frame every route renders inside.
	 *
	 * The wordmark is a link, deliberately **not** a heading: each route owns
	 * exactly one `<h1>` (the play route's is its current phase), and a shell
	 * heading would either steal that slot or push every page's real title down
	 * a level for no benefit to the document outline.
	 *
	 * The header is `position: sticky` but intentionally short — on the play
	 * route the clip timer is the thing the player is watching, so the shell has
	 * to stay out of the way on a phone-height viewport (the acceptance snapshot
	 * is a phone browser, functional-spec §21).
	 */
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import { goto, invalidateAll } from '$app/navigation';
	import { signOut } from '$lib/client/api.js';
	import { m } from '$lib/paraglide/messages.js';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';

	let { data, children } = $props();

	async function handleSignOut() {
		await signOut();
		await invalidateAll();
		await goto(resolve('/'));
	}

	// PWA (task 3.12): SvelteKit auto-registers `src/service-worker.ts` (the
	// default `kit.serviceWorker.register: true` — no svelte.config.js here to
	// override it) — see that file's own doc for what it does and, more to the
	// point, what it deliberately doesn't touch (Deezer audio, API responses).
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#c45d3a" />
</svelte:head>

<div class="shell">
	<header class="masthead">
		<a class="wordmark" href={resolve('/')}>
			<span class="disc" aria-hidden="true"></span>
			<span class="name">Devinyl</span>
		</a>
		<nav class="menu" aria-label={m.nav_primary_label()}>
			<a href={resolve('/(app)/daily')}>{m.nav_daily()}</a>
			<a href={resolve('/(app)/stats')}>{m.nav_stats()}</a>
			{#if data.loggedIn}
				<button type="button" class="link-button" onclick={handleSignOut}>{m.nav_sign_out()}</button
				>
			{:else}
				<a href={resolve('/(app)/login')}>{m.nav_sign_in()}</a>
			{/if}
			<LanguageSwitcher />
		</nav>
	</header>

	<div class="body">
		{@render children()}
	</div>

	<footer class="colophon">
		<p>{m.footer_tagline()}</p>
	</footer>
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
	}

	.body {
		flex: 1;
	}

	.masthead {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--rule);
		/* Tinted rather than transparent: content scrolls underneath it. */
		background: color-mix(in srgb, var(--surface) 88%, transparent);
		backdrop-filter: blur(8px);
	}

	.menu {
		display: flex;
		gap: var(--space-4);
		font-size: var(--text-small);
	}

	.menu a {
		color: var(--ink-muted);
		text-decoration: none;
	}

	.menu a:hover {
		color: var(--accent-ink);
	}

	.link-button {
		font: inherit;
		color: var(--ink-muted);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}

	.link-button:hover {
		color: var(--accent-ink);
	}

	.wordmark {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--ink);
		text-decoration: none;
	}

	/* A record seen edge-on: one dark disc, one accent label, one spindle hole.
	   Three gradients rather than an SVG asset — it has to tint with the theme. */
	.disc {
		width: 1.15rem;
		height: 1.15rem;
		border-radius: var(--radius-pill);
		background:
			radial-gradient(circle, var(--surface) 0 8%, transparent 8%),
			radial-gradient(circle, var(--accent) 8% 34%, transparent 34%),
			repeating-radial-gradient(
				circle,
				var(--ink) 34% 36%,
				color-mix(in srgb, var(--ink) 70%, var(--surface)) 36% 40%
			);
		flex: none;
	}

	.name {
		font-family: var(--font-display);
		font-size: var(--text-title);
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.wordmark:hover .name {
		color: var(--accent-ink);
	}

	.colophon {
		padding: var(--space-5) var(--space-4);
		border-top: 1px solid var(--rule);
		text-align: center;
	}

	.colophon p {
		margin: 0;
		font-size: var(--text-micro);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-faint);
	}
</style>
