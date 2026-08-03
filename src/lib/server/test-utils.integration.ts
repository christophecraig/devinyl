/**
 * Shared integration-test harness — plan task 1.19.
 *
 * This file is deliberately named `*.integration.ts`, not
 * `*.integration.test.ts` — it doesn't match `vitest.integration.config.ts`'s
 * include glob, so vitest never tries to collect it as a suite of its own.
 * It exists so the lifecycle suites (finalize, rounds, scoring — landing
 * separately) don't each reinvent migrations, cleanup, and fixture rows: call
 * `ensureMigrations()` + `resetDb()` in a `beforeEach`, then build whatever
 * graph the test needs from the fixture functions below.
 *
 * Every builder returns the row(s) it inserted (not the input it was given)
 * so a test can assert against server-computed columns (ids, `createdAt`,
 * defaults) without re-deriving them.
 */

import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import {
	decadeOf,
	type CatalogTrack,
	type GenerationFilters,
	type RoundChoices
} from '$lib/game/types.js';
import { buildAnswerKey } from '$lib/game/match.js';
import type { ScoringMode } from '$lib/game/scoring.js';
import type { Db } from './db/index.js';
import * as schema from './db/schema.js';
import { gameSession, quiz, quizTrack, roundResult, trackCache, user } from './db/schema.js';
import type { TrackCacheRow } from './catalog/assembly.js';
import { buildTrackCacheRow, upsertTrackCache } from './catalog/assembly.js';
import { namespacedId, resolveBareId, type CatalogProvider } from './catalog/provider.js';
import { newId } from './ids.js';

// `vitest.integration.config.ts` reads `drizzle/` (Node-side, `node:fs`) and
// hands the parsed migrations across as this plain-data binding — see that
// file's header comment for why the split is necessary. Augmenting
// `Cloudflare.Env` here (rather than casting at each call site) keeps
// `env.TEST_MIGRATIONS` typed everywhere `cloudflare:test`'s `env` is used.
declare global {
	// `Cloudflare.Env` is itself a namespace declared by `wrangler types`;
	// module syntax cannot augment it, so the rule doesn't apply here.
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

// ---------------------------------------------------------------------------
// Db + migrations
// ---------------------------------------------------------------------------

/** A Drizzle instance bound to the local D1 binding, typed identically to `getDb()`'s. */
export function testDb(): Db {
	return drizzle(env.DB, { schema });
}

// `applyD1Migrations` already no-ops on a migration it finds recorded in its
// own `d1_migrations` table, so this is safe to call from every suite's
// `beforeAll`/`beforeEach` — the memoized promise just avoids re-issuing that
// no-op query every time within a single worker instance.
let migrationsApplied: Promise<void> | null = null;

/** Apply every `drizzle/*.sql` migration, in filename order, exactly once per worker instance. */
export function ensureMigrations(): Promise<void> {
	if (!migrationsApplied) {
		migrationsApplied = applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	}
	return migrationsApplied;
}

/**
 * Delete every row from every app table, child tables before the parents
 * they reference (D1 enforces foreign keys — deleting a parent first would
 * throw). Run this between tests, not just between files: Miniflare's
 * isolated-storage snapshot is per test *file*, so tests sharing a file share
 * a database unless this runs.
 */
export async function resetDb(db: Db): Promise<void> {
	// Leaves first, roots last.
	await db.delete(roundResult);
	await db.delete(schema.importedHistory);
	await db.delete(schema.friendship);
	await db.delete(schema.weeklyPoints);
	await db.delete(schema.weeklyRankSnapshot);
	await db.delete(schema.dailyGuestClaim);
	await db.delete(schema.metricsDaily);
	await db.delete(schema.shareEvent);
	await db.delete(schema.rateLimit);
	await db.delete(gameSession);
	await db.delete(schema.challenge);
	await db.delete(schema.dailyQuiz);
	await db.delete(quizTrack);
	await db.delete(quiz);
	await db.delete(trackCache);
	await db.delete(schema.session);
	await db.delete(schema.account);
	await db.delete(schema.verification);
	await db.delete(user);
}

// ---------------------------------------------------------------------------
// Fixture catalog data
// ---------------------------------------------------------------------------

/**
 * `CatalogTrack` shapes for five real tracks (titles/artists/years lifted
 * from `deezer.fixtures.ts`'s captures, so a test reads like real data), used
 * both to seed `track_cache` rows and to back `FakeCatalogProvider`. Kept
 * separate from `deezer.fixtures.ts`, which fixtures the raw Deezer API JSON
 * `DeezerProvider` parses — this harness fixtures the provider-agnostic
 * `CatalogTrack` shape everything past the catalog layer actually consumes.
 */
export const FIXTURE_TRACKS: readonly CatalogTrack[] = [
	{
		providerId: namespacedId('deezer', 3135553),
		title: 'One More Time',
		titleShort: 'One More Time',
		artists: [{ name: 'Daft Punk', primary: true }],
		albumTitle: 'Discovery',
		coverUrl: 'https://cdn-images.dzcdn.net/discovery.jpg',
		releaseYear: 2001,
		genre: 'Electro'
	},
	{
		providerId: namespacedId('deezer', 62847142),
		title: 'Titanium (feat. Sia)',
		titleShort: 'Titanium (feat. Sia)',
		artists: [
			{ name: 'David Guetta', primary: true },
			{ name: 'Sia', primary: false }
		],
		albumTitle: 'Nothing but the Beat (Ultimate Edition)',
		coverUrl: null,
		releaseYear: 2012,
		genre: 'Dance'
	},
	{
		providerId: namespacedId('deezer', 78454982),
		title: 'Papaoutai',
		titleShort: 'Papaoutai',
		artists: [{ name: 'Stromae', primary: true }],
		albumTitle: 'Racine carrée',
		coverUrl: null,
		releaseYear: 2013,
		genre: 'Chanson française'
	},
	{
		providerId: namespacedId('deezer', 823814),
		title: 'Around the World',
		titleShort: 'Around the World',
		artists: [{ name: 'Daft Punk', primary: true }],
		albumTitle: 'Homework',
		coverUrl: null,
		releaseYear: 1997,
		genre: 'Electro'
	},
	{
		providerId: namespacedId('deezer', 111111),
		title: 'Pop Chart Track One',
		titleShort: 'Pop Chart Track One',
		artists: [{ name: 'Pop Artist One', primary: true }],
		albumTitle: 'Pop Album One',
		coverUrl: null,
		releaseYear: 2020,
		genre: 'Pop'
	}
] as const;

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

export type UserRow = typeof user.$inferSelect;
export type QuizRow = typeof quiz.$inferSelect;
export type QuizTrackRow = typeof quizTrack.$inferSelect;
export type GameSessionRow = typeof gameSession.$inferSelect;
export type RoundResultRow = typeof roundResult.$inferSelect;

/** A registered user row — only needed by tests exercising owner/user-id FKs. */
export async function createUser(
	db: Db,
	overrides: Partial<typeof user.$inferInsert> = {}
): Promise<UserRow> {
	const id = overrides.id ?? newId();
	const [row] = await db
		.insert(user)
		.values({
			id,
			name: 'Fixture User',
			email: `${id}@example.test`,
			displayName: 'Fixture User',
			displayNameNormalized: 'fixture user',
			...overrides
		})
		.returning();
	return row;
}

/**
 * One `track_cache` row, built via the same `buildTrackCacheRow` +
 * `buildAnswerKey` path `catalog/assembly.ts` uses for a real add — so a
 * fixture track's `answers` column is exactly as strict/lenient as
 * production's, not a hand-rolled approximation.
 */
export async function createTrack(
	db: Db,
	overrides: Partial<CatalogTrack> = {},
	opts: { previewMs?: number } = {}
): Promise<TrackCacheRow> {
	const base = overrides.providerId
		? (FIXTURE_TRACKS.find((t) => t.providerId === overrides.providerId) ?? FIXTURE_TRACKS[0])
		: FIXTURE_TRACKS[0];
	const track: CatalogTrack = { ...base, ...overrides };
	const row = buildTrackCacheRow(track, { previewMs: opts.previewMs ?? 30_000 });
	await upsertTrackCache(db, row);
	return row;
}

function distractorPool(excludeProviderId: string): readonly CatalogTrack[] {
	return FIXTURE_TRACKS.filter((t) => t.providerId !== excludeProviderId);
}

/** Four plain options per requested target — content only, no shuffle (display order is client-side per session, §6). */
function buildFixtureChoices(
	track: TrackCacheRow,
	guessTarget: 'both' | 'title' | 'artist'
): RoundChoices {
	const pool = distractorPool(track.id);
	const choices: RoundChoices = {};
	if (guessTarget === 'both' || guessTarget === 'title') {
		choices.title = [track.title, ...pool.slice(0, 3).map((t) => t.title)];
	}
	if (guessTarget === 'both' || guessTarget === 'artist') {
		choices.artist = [track.artists[0].name, ...pool.slice(0, 3).map((t) => t.artists[0].name)];
	}
	return choices;
}

export interface CreateQuizOptions {
	/** Number of fixture tracks to attach, in `FIXTURE_TRACKS` order. Max 5 (the fixture pool size). */
	trackCount?: number;
	answerMode?: 'text' | 'choice';
	guessTarget?: 'both' | 'title' | 'artist';
	scoringMode?: ScoringMode;
	ownerId?: string | null;
	kind?: 'manual' | 'generated' | 'official' | 'daily';
	name?: string;
}

export interface QuizFixture {
	quiz: QuizRow;
	tracks: TrackCacheRow[];
	quizTracks: QuizTrackRow[];
}

/**
 * A playable quiz: N `track_cache` rows plus their `quiz_track` rows, in the
 * shape `sessions/create.ts` reads (position-ordered, `choices` populated
 * only for `answerMode: 'choice'` — text-mode quizzes carry `choices: null`,
 * same as a real manual/text quiz never touching `distractors.ts`).
 */
export async function createQuiz(db: Db, options: CreateQuizOptions = {}): Promise<QuizFixture> {
	const trackCount = options.trackCount ?? 3;
	if (trackCount > FIXTURE_TRACKS.length) {
		throw new Error(
			`createQuiz: trackCount ${trackCount} exceeds the ${FIXTURE_TRACKS.length} available fixture tracks`
		);
	}
	const answerMode = options.answerMode ?? 'text';
	const guessTarget = options.guessTarget ?? 'both';

	const tracks: TrackCacheRow[] = [];
	for (const fixture of FIXTURE_TRACKS.slice(0, trackCount)) {
		tracks.push(await createTrack(db, { ...fixture }));
	}

	const quizId = newId();
	const [quizRow] = await db
		.insert(quiz)
		.values({
			id: quizId,
			ownerId: options.ownerId ?? null,
			kind: options.kind ?? 'manual',
			name: options.name ?? 'Fixture quiz',
			guessTarget,
			answerMode,
			scoringMode: options.scoringMode ?? 'speed',
			curveVersion: 1
		})
		.returning();

	const quizTracks: QuizTrackRow[] = [];
	for (let position = 0; position < tracks.length; position++) {
		const track = tracks[position];
		const [row] = await db
			.insert(quizTrack)
			.values({
				quizId,
				position,
				trackId: track.id,
				choices: answerMode === 'choice' ? buildFixtureChoices(track, guessTarget) : null
			})
			.returning();
		quizTracks.push(row);
	}

	return { quiz: quizRow, tracks, quizTracks };
}

/** A `game_session` row for a quiz created by `createQuiz` (or any `quiz` row a test already has). */
export async function createGameSession(
	db: Db,
	quizRow: QuizRow,
	overrides: Partial<typeof gameSession.$inferInsert> = {}
): Promise<GameSessionRow> {
	const [row] = await db
		.insert(gameSession)
		.values({
			id: overrides.id ?? newId(),
			quizId: quizRow.id,
			userId: null,
			guestId: 'fixture-guest',
			nickname: 'Fixture Player',
			status: 'active',
			scored: false,
			curveVersion: quizRow.curveVersion,
			effectiveScoringMode: quizRow.scoringMode,
			startedAt: Date.now(),
			serverRoundLog: [],
			...overrides
		})
		.returning();
	return row;
}

/** A `round_result` row for a session created by `createGameSession`. */
export async function createRoundResult(
	db: Db,
	session: GameSessionRow,
	position: number,
	overrides: Partial<typeof roundResult.$inferInsert> = {}
): Promise<RoundResultRow> {
	const [row] = await db
		.insert(roundResult)
		.values({
			sessionId: session.id,
			position,
			titleOk: null,
			artistOk: null,
			skipped: false,
			clipMs: 30_000,
			titleMs: null,
			artistMs: null,
			points: 0,
			guessLog: [],
			claimedTitleMs: null,
			claimedArtistMs: null,
			serverReceivedAt: null,
			...overrides
		})
		.returning();
	return row;
}

// ---------------------------------------------------------------------------
// Fake CatalogProvider (no network — technical-spec §17)
// ---------------------------------------------------------------------------

/**
 * A deterministic, in-memory `CatalogProvider` over `FIXTURE_TRACKS`. Unlike
 * `deezer.fixtures.ts`'s `createStubFetch` (which fixtures Deezer's HTTP
 * shape for `DeezerProvider`'s own tests), this fixtures the interface
 * itself — for tests one layer up, exercising `sessions/create.ts` and
 * `quizzes/generate.ts` against *some* provider without caring which.
 */
export class FakeCatalogProvider implements CatalogProvider {
	readonly name = 'deezer';

	private readonly tracks: readonly CatalogTrack[];
	private readonly failPreviewIds = new Set<string>();

	constructor(tracks: readonly CatalogTrack[] = FIXTURE_TRACKS) {
		this.tracks = tracks;
	}

	/**
	 * Test knob for the FAIR-6 / skipped-round path: after this call,
	 * `getPreviewUrl` resolves `null` for this track (bare or namespaced id),
	 * as if its clip had gone dead upstream — exactly what
	 * `resolvePreviewUrls` in `sessions/create.ts` treats as a skip.
	 */
	failPreviewFor(providerTrackId: string): void {
		this.failPreviewIds.add(resolveBareId(this.name, providerTrackId));
	}

	async searchTracks(q: string): Promise<CatalogTrack[]> {
		const needle = q.toLowerCase();
		return this.tracks.filter(
			(t) =>
				t.title.toLowerCase().includes(needle) ||
				t.artists.some((a) => a.name.toLowerCase().includes(needle))
		);
	}

	async getTrack(providerTrackId: string): Promise<CatalogTrack | null> {
		const bare = resolveBareId(this.name, providerTrackId);
		return this.tracks.find((t) => resolveBareId(this.name, t.providerId) === bare) ?? null;
	}

	async getPreviewUrl(providerTrackId: string): Promise<string | null> {
		const bare = resolveBareId(this.name, providerTrackId);
		if (this.failPreviewIds.has(bare)) return null;
		const track = await this.getTrack(bare);
		return track ? `https://fixture.test/preview/${bare}.mp3` : null;
	}

	async poolForFilters(f: GenerationFilters): Promise<CatalogTrack[]> {
		return this.tracks
			.filter(
				(t) =>
					(f.decade == null || decadeOf(t.releaseYear) === f.decade) &&
					(f.genre == null || t.genre === f.genre)
			)
			.slice(0, f.rounds);
	}
}

// Re-exported so a test asserting on precomputed answers doesn't need its own
// import of `match.ts` just to build the expectation.
export { buildAnswerKey };
