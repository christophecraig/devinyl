/**
 * Service worker — plan task 3.12 (PWA), §4 offline resilience.
 *
 * Caches the **app shell only** — the build output and `static/` files
 * SvelteKit already knows about via `$service-worker`. Deliberately does
 * **not** touch anything else: Deezer preview URLs are short-lived signed
 * tokens (§5.2) that would 403 from a stale cache, and API responses are
 * session-scoped state that a cache would just make wrong. §4's actual
 * offline story — preloaded audio buffers, the queued-beacon/finalize retry
 * — already lives client-side in `preloader.ts`/`queue.ts` and needs no
 * help from this file.
 *
 * `event.respondWith` is called **only** for a request whose URL is in the
 * precached set; everything else falls through to the network exactly as if
 * this service worker didn't exist, which is what keeps the "never audio,
 * never API" guarantee mechanical rather than a rule to remember.
 */

/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = `devinyl-shell-${version}`;
const SHELL_URLS = new Set(
	[...build, ...files].map((path) => new URL(path, self.location.origin).href)
);

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(build.concat(files)))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	if (!SHELL_URLS.has(event.request.url)) return;

	event.respondWith(
		caches.open(CACHE_NAME).then(async (cache) => {
			const cached = await cache.match(event.request);
			if (cached) return cached;
			// A shell asset that isn't cached yet (e.g. install raced a nav) —
			// fetch it live and cache it for next time.
			const response = await fetch(event.request);
			if (response.ok) cache.put(event.request, response.clone());
			return response;
		})
	);
});
