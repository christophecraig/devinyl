/**
 * The one place a `CatalogProvider` is constructed.
 *
 * Every route resolves its provider through here rather than instantiating
 * `DeezerProvider` inline, so the provider swap ADR-0001 keeps live (§19, plan
 * §G-15) is a one-line change here plus a new implementation file — not a sweep
 * through every call site.
 *
 * The Workers Cache API instance is passed in explicitly: `caches.default` only
 * exists in the real Workers runtime, and reading it from a global would break
 * the node-environment unit tests (see `DeezerProviderOptions.cache`).
 */

import { DeezerProvider, type ReadThroughCache } from './deezer.js';
import type { CatalogProvider } from './provider.js';

export function getProvider(platform: App.Platform): CatalogProvider {
	return new DeezerProvider({
		// Two incompatible `Request`/`Headers` declarations are in scope at once —
		// the runtime types `wrangler types` generates, and the copy of
		// @cloudflare/workers-types v4 that drizzle-kit drags in — so
		// `caches.default.match` is nominally unassignable to `ReadThroughCache`
		// despite being the exact API it describes. The cast is confined to this
		// one boundary rather than weakening `ReadThroughCache` for every caller.
		cache: platform.caches?.default as unknown as ReadThroughCache | undefined
	});
}

export type { CatalogProvider };
