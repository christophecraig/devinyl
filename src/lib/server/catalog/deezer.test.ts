import { describe, expect, it, vi } from 'vitest';
import { DeezerProvider } from './deezer.js';
import { namespacedId, parseNamespacedId, resolveBareId } from './provider.js';
import { createStubFetch } from './deezer.fixtures.js';
import { Throttle } from './throttle.js';

describe('namespaced ids (plan §G-15)', () => {
	it('round-trips provider + bare id', () => {
		const id = namespacedId('deezer', 3135553);
		expect(id).toBe('deezer:3135553');
		expect(parseNamespacedId(id)).toEqual({ provider: 'deezer', providerTrackId: '3135553' });
	});

	it('resolveBareId accepts a bare id unchanged', () => {
		expect(resolveBareId('deezer', '3135553')).toBe('3135553');
	});

	it('resolveBareId unwraps a matching namespaced id', () => {
		expect(resolveBareId('deezer', 'deezer:3135553')).toBe('3135553');
	});

	it('resolveBareId throws on a foreign namespace', () => {
		expect(() => resolveBareId('deezer', 'itunes:987')).toThrow(/itunes/);
	});

	it('parseNamespacedId rejects malformed input', () => {
		expect(parseNamespacedId('no-colon')).toBeNull();
		expect(parseNamespacedId(':empty-provider')).toBeNull();
		expect(parseNamespacedId('deezer:')).toBeNull();
	});
});

describe('DeezerProvider.getTrack — hydration', () => {
	it('hydrates a single-contributor track with album genre + release year', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const track = await provider.getTrack('3135553');

		expect(track).not.toBeNull();
		expect(track!.providerId).toBe('deezer:3135553');
		expect(track!.title).toBe('One More Time');
		expect(track!.titleShort).toBe('One More Time');
		expect(track!.artists).toEqual([{ name: 'Daft Punk', primary: true }]);
		expect(track!.albumTitle).toBe('Discovery');
		expect(track!.genre).toBe('Electro');
		expect(track!.releaseYear).toBe(2001);
	});

	it('accepts a namespaced id transparently', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const track = await provider.getTrack('deezer:3135553');
		expect(track!.providerId).toBe('deezer:3135553');
	});

	it('flags only the first contributor primary, keeps every credited artist (ANS-3)', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const track = await provider.getTrack('62847142');

		expect(track!.artists).toEqual([
			{ name: 'David Guetta', primary: true },
			{ name: 'Sia', primary: false }
		]);
		expect(track!.genre).toBe('Dance');
		expect(track!.releaseYear).toBe(2012);
	});

	it('returns null for an id Deezer answers with its 200-with-{error} quirk', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const track = await provider.getTrack('999999999999999');
		expect(track).toBeNull();
	});
});

describe('DeezerProvider.searchTracks', () => {
	it('returns lightweight tracks with genre/releaseYear null (hydration deferred)', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const results = await provider.searchTracks('Stromae Papaoutai');

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].providerId).toBe('deezer:78454982');
		expect(results[0].genre).toBeNull();
		expect(results[0].releaseYear).toBeNull();
	});

	it('returns an empty array, not null, for no results', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const results = await provider.searchTracks('zzzz-nothing-matches-zzzz');
		expect(results).toEqual([]);
	});
});

describe('DeezerProvider.findTrackByArtistAndTitle — strict then fallback (probe-derived)', () => {
	it('finds a strict-query hit directly', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const hit = await provider.findTrackByArtistAndTitle('Daft Punk', 'One More Time');
		expect(hit?.id).toBe(3135553);
	});

	it('falls back to a plain query when the strict query finds nothing', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		// "Stromae" / "Papaoutai" strict query isn't in the fixture map (only the
		// Daft Punk strict query is), so this exercises the plain-query fallback.
		const hit = await provider.findTrackByArtistAndTitle('Stromae', 'Papaoutai');
		expect(hit?.id).toBe(78454982);
	});
});

describe('DeezerProvider.resolveArtistByName — §G-16 nb_fan ranking', () => {
	it('picks the highest-nb_fan exact match, not the first result', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const artist = await provider.resolveArtistByName('Air');

		// Three candidates are exact "Air" name matches (ids 369, 64312862,
		// 64324132) with wildly different fan counts. The naive "first exact
		// match" bug the probe caught would return whichever comes first in
		// Deezer's search order — the fix must pick the highest nb_fan among
		// them (id 369, 338,987 fans) regardless of order.
		expect(artist?.id).toBe(369);
		expect(artist?.name).toBe('Air');
		expect(artist?.nb_fan).toBe(338987);
	});

	it('returns null when the search has no candidates', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const artist = await provider.resolveArtistByName('Totally Unknown Artist Xyz');
		expect(artist).toBeNull();
	});
});

describe('DeezerProvider.resolveGenreId', () => {
	it('resolves an exact (case/diacritic-insensitive) name', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		expect(await provider.resolveGenreId('pop')).toBe(132);
		expect(await provider.resolveGenreId('CHANSON FRANÇAISE')).toBe(52);
	});

	it('resolves a substring match', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		expect(await provider.resolveGenreId('Rap')).toBe(116);
	});

	it('returns null for a genre with no plausible match', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		expect(await provider.resolveGenreId('Yodel')).toBeNull();
	});
});

describe('DeezerProvider.poolForFilters', () => {
	it('draws from an artist top-tracks pool when seed is set', async () => {
		// resolveArtistByName isn't stubbed for "Daft Punk" in the artist-search
		// fixture map, so override just that one lookup.
		const fetchImpl = createStubFetch({
			override: (url) => {
				if (url.includes('/search/artist') && url.includes('Daft')) {
					return new Response(
						JSON.stringify({ data: [{ id: 27, name: 'Daft Punk', nb_fan: 5_000_000 }] }),
						{
							headers: { 'content-type': 'application/json' }
						}
					);
				}
				return undefined;
			}
		});
		const seededProvider = new DeezerProvider({ fetch: fetchImpl });
		const pool = await seededProvider.poolForFilters({ seed: 'Daft Punk', rounds: 10 });

		expect(pool.length).toBeGreaterThan(0);
		expect(pool.every((t) => t.providerId.startsWith('deezer:'))).toBe(true);
	});

	it('draws from a genre chart when genre is set', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const pool = await provider.poolForFilters({ genre: 'Pop', rounds: 5 });
		expect(pool.length).toBe(2);
		expect(pool[0].title).toBe('Pop Chart Track One');
	});

	it('falls back to the overall chart with no filters', async () => {
		const provider = new DeezerProvider({ fetch: createStubFetch() });
		const pool = await provider.poolForFilters({ rounds: 5 });
		expect(pool.length).toBeGreaterThan(0);
	});
});

describe('Throttle — reactive 429 backoff (ADR-0001 Q2: no hardcoded budget)', () => {
	it('retries on 429 honouring Retry-After, then succeeds', async () => {
		const sleep = vi.fn(async () => undefined);
		const throttle = new Throttle({ maxRetries: 3, sleep });

		let calls = 0;
		const res = await throttle.run(async () => {
			calls++;
			if (calls < 3) {
				return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
			}
			return new Response('ok', { status: 200 });
		});

		expect(res.status).toBe(200);
		expect(calls).toBe(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1000);
	});

	it('gives up and returns the last response after maxRetries', async () => {
		const sleep = vi.fn(async () => undefined);
		const throttle = new Throttle({ maxRetries: 2, sleep });

		let calls = 0;
		const res = await throttle.run(async () => {
			calls++;
			return new Response(null, { status: 429 });
		});

		expect(res.status).toBe(429);
		expect(calls).toBe(3); // initial attempt + 2 retries
	});

	it('caps concurrency', async () => {
		const throttle = new Throttle({ maxConcurrent: 2 });
		let concurrent = 0;
		let maxObserved = 0;

		const task = () =>
			throttle.run(async () => {
				concurrent++;
				maxObserved = Math.max(maxObserved, concurrent);
				await new Promise((resolve) => setTimeout(resolve, 10));
				concurrent--;
				return new Response('ok', { status: 200 });
			});

		await Promise.all([task(), task(), task(), task(), task()]);
		expect(maxObserved).toBeLessThanOrEqual(2);
	});
});
