import { describe, expect, it, vi } from 'vitest';
import type { CatalogTrack } from '$lib/game/types.js';
import type { CatalogProvider } from './provider.js';
import { buildTrackCacheRow, ensureTrackCached } from './assembly.js';
import type { Db } from '../db/index.js';

const titaniumTrack: CatalogTrack = {
	providerId: 'deezer:62847142',
	title: 'Titanium (feat. Sia)',
	titleShort: 'Titanium (feat. Sia)',
	artists: [
		{ name: 'David Guetta', primary: true },
		{ name: 'Sia', primary: false }
	],
	albumTitle: 'Nothing but the Beat',
	coverUrl: 'https://cdn-images.dzcdn.net/titanium.jpg',
	releaseYear: 2012,
	genre: 'Dance'
};

describe('buildTrackCacheRow', () => {
	it('produces a full track_cache row from a hydrated CatalogTrack', () => {
		const row = buildTrackCacheRow(titaniumTrack, { previewMs: 29_989, fetchedAt: 1_000 });

		expect(row.id).toBe('deezer:62847142');
		expect(row.provider).toBe('deezer');
		expect(row.providerTrackId).toBe('62847142');
		expect(row.decade).toBe(2010);
		expect(row.previewMs).toBe(29_989);
		expect(row.fetchedAt).toBe(1_000);
		expect(row.unavailableAt).toBeNull();
	});

	it('computes answers via the shared buildAnswerKey — title strips the feat. suffix, both artists accepted', () => {
		const row = buildTrackCacheRow(titaniumTrack, { previewMs: 29_989 });

		// "feat." stripping (§8.1 step 4) — the bare title must be accepted.
		expect(row.answers.title).toContain('titanium');
		// ANS-3: every credited artist is an accepted answer, not just the primary.
		expect(row.answers.artist).toContain('david guetta');
		expect(row.answers.artist).toContain('sia');
	});

	it('derives decade null when releaseYear is null (reissues with missing metadata)', () => {
		const row = buildTrackCacheRow({ ...titaniumTrack, releaseYear: null }, { previewMs: 29_989 });
		expect(row.decade).toBeNull();
	});

	it('rejects a non-namespaced providerId — this must never reach track_cache', () => {
		expect(() =>
			buildTrackCacheRow({ ...titaniumTrack, providerId: '62847142' }, { previewMs: 1 })
		).toThrow(/namespaced/);
	});
});

/** Minimal stub matching the `db.insert(table).values(row).onConflictDoUpdate(...)` chain used by `upsertTrackCache`. */
function fakeDb(): { db: Db; insertedValues: unknown[] } {
	const insertedValues: unknown[] = [];
	const db = {
		insert: () => ({
			values: (v: unknown) => {
				insertedValues.push(v);
				return { onConflictDoUpdate: async () => undefined };
			}
		})
	} as unknown as Db;
	return { db, insertedValues };
}

function fakeProvider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
	return {
		name: 'deezer',
		searchTracks: vi.fn(async () => []),
		getTrack: vi.fn(async () => titaniumTrack),
		getPreviewUrl: vi.fn(async () => 'https://example.test/titanium-preview.mp3'),
		poolForFilters: vi.fn(async () => []),
		...overrides
	};
}

function fetchStub(status: number, contentRange: string | null): typeof fetch {
	return (async () =>
		new Response(new Uint8Array([0, 1]), {
			status,
			headers: contentRange ? { 'content-range': contentRange } : {}
		})) as typeof fetch;
}

describe('ensureTrackCached — MUS-5 add-time enforcement', () => {
	it('caches a track whose preview checks out', async () => {
		const { db, insertedValues } = fakeDb();
		const provider = fakeProvider();

		const result = await ensureTrackCached(db, provider, 'deezer:62847142', {
			fetchImpl: fetchStub(206, 'bytes 0-1/479827')
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.row.previewMs).toBe(29_989);
		}
		expect(insertedValues).toHaveLength(1);
	});

	it('refuses and does NOT write to track_cache when the track is not found', async () => {
		const { db, insertedValues } = fakeDb();
		const provider = fakeProvider({ getTrack: vi.fn(async () => null) });

		const result = await ensureTrackCached(db, provider, 'deezer:0', {});

		expect(result).toMatchObject({ ok: false, reason: 'not_found' });
		expect(insertedValues).toHaveLength(0);
	});

	it('refuses when there is no preview URL at all', async () => {
		const { db, insertedValues } = fakeDb();
		const provider = fakeProvider({ getPreviewUrl: vi.fn(async () => null) });

		const result = await ensureTrackCached(db, provider, 'deezer:62847142', {});

		expect(result).toMatchObject({ ok: false, reason: 'no_preview' });
		expect(insertedValues).toHaveLength(0);
	});

	it('refuses a known-dead clip (MUS-5: never saved with a dead preview) with a creator-facing message', async () => {
		const { db, insertedValues } = fakeDb();
		const provider = fakeProvider();

		const result = await ensureTrackCached(db, provider, 'deezer:62847142', {
			fetchImpl: fetchStub(404, null)
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('preview_unavailable');
			expect(result.message).toContain('Titanium');
		}
		expect(insertedValues).toHaveLength(0);
	});
});
