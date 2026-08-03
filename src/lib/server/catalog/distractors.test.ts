import { describe, expect, it, vi } from 'vitest';
import type { CatalogProvider } from './provider.js';
import { buildRoundChoices, pickDistractors } from './distractors.js';
import type { Db } from '../db/index.js';
import type { trackCache } from '../db/schema.js';

type TrackCacheRow = typeof trackCache.$inferSelect;

function mkRow(overrides: Partial<TrackCacheRow> & { id: string; title: string }): TrackCacheRow {
	return {
		provider: 'deezer',
		providerTrackId: overrides.id.split(':')[1] ?? overrides.id,
		titleShort: overrides.title,
		artists: [{ name: 'Some Artist', primary: true }],
		albumTitle: 'Some Album',
		coverUrl: null,
		releaseYear: 2015,
		genre: 'Pop',
		decade: 2010,
		answers: { title: [overrides.title.toLowerCase()], artist: ['some artist'] },
		previewMs: 29_989,
		fetchedAt: 0,
		unavailableAt: null,
		...overrides
	};
}

/**
 * `queryCacheTiers` (distractors.ts) issues up to 3 queries in a fixed order:
 * same-decade, same-genre, then an unfiltered "any" tier. Each ends in
 * `.limit()`, which this stub treats as the terminal call and resolves from
 * `tierResponses` in call order.
 */
function fakeDb(tierResponses: TrackCacheRow[][]): Db {
	let call = 0;
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: async () => {
			const res = tierResponses[call] ?? [];
			call++;
			return res;
		}
	};
	return chain as unknown as Db;
}

function fakeProvider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
	return {
		name: 'deezer',
		searchTracks: vi.fn(async () => []),
		getTrack: vi.fn(async () => null),
		getPreviewUrl: vi.fn(async () => null),
		poolForFilters: vi.fn(async () => []),
		...overrides
	};
}

describe('pickDistractors — cache tiers', () => {
	it('prefers the same-decade tier when it has enough clean candidates', async () => {
		const decadeTier = [
			mkRow({ id: 'deezer:1', title: 'Alpha' }),
			mkRow({ id: 'deezer:2', title: 'Bravo' }),
			mkRow({ id: 'deezer:3', title: 'Charlie' })
		];
		const genreTier = [mkRow({ id: 'deezer:9', title: 'ShouldNotBeUsed' })];
		const anyTier = [mkRow({ id: 'deezer:8', title: 'AlsoUnused' })];

		const db = fakeDb([decadeTier, genreTier, anyTier]);
		const picks = await pickDistractors({
			db,
			target: 'title',
			excludeTrackId: 'deezer:correct',
			correctForms: ['correct song'],
			genre: 'Pop',
			decade: 2010
		});

		expect(picks).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	it('falls through to the genre tier when the decade tier is thin', async () => {
		const decadeTier = [mkRow({ id: 'deezer:1', title: 'Alpha' })];
		const genreTier = [
			mkRow({ id: 'deezer:2', title: 'Bravo' }),
			mkRow({ id: 'deezer:3', title: 'Charlie' })
		];
		const anyTier: TrackCacheRow[] = [];

		const db = fakeDb([decadeTier, genreTier, anyTier]);
		const picks = await pickDistractors({
			db,
			target: 'title',
			excludeTrackId: 'deezer:correct',
			correctForms: [],
			genre: 'Pop',
			decade: 2010
		});

		expect(picks).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	it('drops a candidate whose normalized form collides with the correct answer', async () => {
		// "Papaoutai" and "Papaoutaï" normalize identically — must not appear
		// alongside the correct answer as a distractor.
		const decadeTier = [
			mkRow({ id: 'deezer:1', title: 'Papaoutaï' }),
			mkRow({ id: 'deezer:2', title: 'Bravo' }),
			mkRow({ id: 'deezer:3', title: 'Charlie' }),
			mkRow({ id: 'deezer:4', title: 'Delta' })
		];
		const db = fakeDb([decadeTier, [], []]);
		const picks = await pickDistractors({
			db,
			target: 'title',
			excludeTrackId: 'deezer:correct',
			correctForms: ['papaoutai'],
			genre: 'Pop',
			decade: 2010
		});

		expect(picks).not.toContain('Papaoutaï');
		expect(picks).toEqual(['Bravo', 'Charlie', 'Delta']);
	});

	it('drops a candidate whose normalized form collides with an already-chosen distractor', async () => {
		const decadeTier = [
			mkRow({ id: 'deezer:1', title: 'Bravo' }),
			mkRow({ id: 'deezer:2', title: 'BRAVO' }), // same normalized form as the first pick
			mkRow({ id: 'deezer:3', title: 'Charlie' }),
			mkRow({ id: 'deezer:4', title: 'Delta' })
		];
		const db = fakeDb([decadeTier, [], []]);
		const picks = await pickDistractors({
			db,
			target: 'title',
			excludeTrackId: 'deezer:correct',
			correctForms: [],
			genre: 'Pop',
			decade: 2010
		});

		expect(picks).toEqual(['Bravo', 'Charlie', 'Delta']);
	});

	it('returns fewer than count when both cache and (absent) live fallback are exhausted', async () => {
		const db = fakeDb([[mkRow({ id: 'deezer:1', title: 'Alpha' })], [], []]);
		const picks = await pickDistractors({
			db,
			target: 'title',
			excludeTrackId: 'deezer:correct',
			correctForms: [],
			genre: 'Pop',
			decade: 2010
			// no provider supplied — must not attempt a live call
		});

		expect(picks).toEqual(['Alpha']);
	});

	it('falls back to a live provider call when the cache bucket is too thin (§8.3)', async () => {
		const db = fakeDb([[mkRow({ id: 'deezer:1', title: 'Alpha' })], [], []]);
		const poolForFilters = vi.fn(async () => [
			{
				providerId: 'deezer:live-1',
				title: 'LiveTrack',
				titleShort: 'LiveTrack',
				artists: [{ name: 'Live Artist', primary: true }],
				albumTitle: '',
				coverUrl: null,
				releaseYear: null,
				genre: null
			},
			{
				providerId: 'deezer:correct', // must be excluded even if the live pool returns it
				title: 'CorrectSong',
				titleShort: 'CorrectSong',
				artists: [{ name: 'X', primary: true }],
				albumTitle: '',
				coverUrl: null,
				releaseYear: null,
				genre: null
			},
			{
				providerId: 'deezer:live-2',
				title: 'LiveTrackTwo',
				titleShort: 'LiveTrackTwo',
				artists: [{ name: 'Live Artist Two', primary: true }],
				albumTitle: '',
				coverUrl: null,
				releaseYear: null,
				genre: null
			}
		]);
		const provider = fakeProvider({ poolForFilters });

		const picks = await pickDistractors({
			db,
			target: 'title',
			excludeTrackId: 'deezer:correct',
			correctForms: [],
			genre: 'Pop',
			decade: 2010,
			provider
		});

		expect(poolForFilters).toHaveBeenCalledTimes(1);
		expect(picks).toEqual(['Alpha', 'LiveTrack', 'LiveTrackTwo']);
	});

	it('picks the primary artist name for the artist target', async () => {
		const decadeTier = [
			mkRow({
				id: 'deezer:1',
				title: 'Song A',
				artists: [
					{ name: 'Feature Artist', primary: false },
					{ name: 'Main Artist', primary: true }
				]
			})
		];
		const db = fakeDb([decadeTier, [mkRow({ id: 'deezer:2', title: 'Song B' })], []]);
		const picks = await pickDistractors({
			db,
			target: 'artist',
			excludeTrackId: 'deezer:correct',
			correctForms: [],
			genre: 'Pop',
			decade: 2010,
			count: 1
		});

		expect(picks).toEqual(['Main Artist']);
	});
});

describe('buildRoundChoices', () => {
	it('assembles correct + 3 distractors per requested target', async () => {
		const correctRow = mkRow({
			id: 'deezer:correct',
			title: 'Correct Song',
			artists: [{ name: 'Correct Artist', primary: true }],
			answers: { title: ['correct song'], artist: ['correct artist'] }
		});
		const decadeTier = [
			mkRow({ id: 'deezer:1', title: 'Alpha' }),
			mkRow({ id: 'deezer:2', title: 'Bravo' }),
			mkRow({ id: 'deezer:3', title: 'Charlie' })
		];
		const db = fakeDb([decadeTier, [], []]);

		const choices = await buildRoundChoices(db, correctRow, ['title']);

		expect(choices.title).toEqual(['Correct Song', 'Alpha', 'Bravo', 'Charlie']);
		expect(choices.artist).toBeUndefined();
	});
});
