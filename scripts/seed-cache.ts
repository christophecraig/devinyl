#!/usr/bin/env -S npx tsx@latest
/**
 * scripts/seed-cache.ts — cache warm-up seeding, plan §G-4 / task 1.12.
 *
 * Populates `track_cache` from artists' top tracks (biased toward the French
 * repertoire in `scripts/probes.json`) so day-one generated choice-mode
 * quizzes don't stampede live Deezer calls — that's the entire reason
 * `track_cache` is indexed by `(genre, decade)` (`distractors.ts`, §8.3).
 *
 * ── How it writes to D1 ──────────────────────────────────────────────────
 * This is a plain `tsx` script (Node, not the Workers runtime), so it has no
 * D1 binding to write through directly. It reuses the real app code —
 * `DeezerProvider` (task 1.9), `checkPreviewAvailability` (task 1.10's
 * availability enforcement) and `buildTrackCacheRow` (task 1.10) — to fetch,
 * verify, and shape each row exactly the way manual/generated quiz assembly
 * would, then emits one SQL file of idempotent
 * `INSERT ... ON CONFLICT(id) DO UPDATE` statements and hands it to
 * `wrangler d1 execute --file=…`, which *does* have a real D1 connection
 * (local SQLite file in dev, the real remote database with `--remote`).
 * This two-step "generate SQL, then let wrangler apply it" split was tested
 * end-to-end against a local D1 instance while building this script — both
 * halves work, and idempotency was verified by applying the same file twice.
 *
 * Usage:
 *   npx tsx scripts/seed-cache.ts                       # local D1 (safe default)
 *   npx tsx scripts/seed-cache.ts --remote               # PRODUCTION D1 — be sure
 *   npx tsx scripts/seed-cache.ts --sql-only              # write the .sql file, apply it yourself
 *   npx tsx scripts/seed-cache.ts --artists=5 --per-artist=10   # smoke-test with a small slice
 *
 * Idempotent: re-running is always safe — every row is an upsert keyed on the
 * namespaced `track_cache.id` (plan §G-15), never an append.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DeezerProvider } from '../src/lib/server/catalog/deezer.js';
import { checkPreviewAvailability } from '../src/lib/server/catalog/availability.js';
import { buildTrackCacheRow, type TrackCacheRow } from '../src/lib/server/catalog/assembly.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = path.join(__dirname, 'probes.json');
const SQL_OUTPUT_PATH = path.join(__dirname, '.seed-cache.sql');

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const REMOTE = args.includes('--remote');
const SQL_ONLY = args.includes('--sql-only');
const ARTIST_LIMIT = numberFlag('--artists') ?? Infinity;
const PER_ARTIST_LIMIT = numberFlag('--per-artist') ?? 25;

function numberFlag(name: string): number | undefined {
	const hit = args.find((a) => a.startsWith(`${name}=`));
	if (!hit) return undefined;
	const n = Number(hit.slice(name.length + 1));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Artist list — biased toward French repertoire (plan 1.12): every artist
// named in probes.json's track and artist probes, deduplicated. That corpus
// was itself curated for French-repertoire breadth across chanson, variété,
// pop, rap, rock and electro, classics and current (Gate 0, task 0.1) —
// reusing it here means the warm cache is biased the same deliberate way,
// not by accident.
// ---------------------------------------------------------------------------

interface ProbesFile {
	trackProbes: { artist: string; genre: string }[];
	artistProbes: string[];
}

async function loadArtistList(): Promise<string[]> {
	const raw = await readFile(PROBES_PATH, 'utf-8');
	const probes = JSON.parse(raw) as ProbesFile;
	const names = new Set<string>();
	for (const p of probes.trackProbes) names.add(p.artist);
	for (const a of probes.artistProbes) names.add(a);
	return [...names];
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

function sqlString(value: string | null): string {
	if (value === null) return 'NULL';
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlNumber(value: number | null): string {
	return value === null ? 'NULL' : String(value);
}

function sqlJson(value: unknown): string {
	return sqlString(JSON.stringify(value));
}

/** One idempotent upsert statement per row — verified live against local D1 while building this script. */
function upsertStatement(row: TrackCacheRow): string {
	const columns = [
		'id',
		'provider',
		'provider_track_id',
		'title',
		'title_short',
		'artists',
		'album_title',
		'cover_url',
		'release_year',
		'genre',
		'decade',
		'answers',
		'preview_ms',
		'fetched_at',
		'unavailable_at'
	];
	const values = [
		sqlString(row.id),
		sqlString(row.provider),
		sqlString(row.providerTrackId),
		sqlString(row.title),
		sqlString(row.titleShort),
		sqlJson(row.artists),
		sqlString(row.albumTitle),
		sqlString(row.coverUrl),
		sqlNumber(row.releaseYear),
		sqlString(row.genre),
		sqlNumber(row.decade),
		sqlJson(row.answers),
		sqlNumber(row.previewMs),
		sqlNumber(row.fetchedAt),
		sqlNumber(row.unavailableAt)
	];

	return (
		`INSERT INTO track_cache (${columns.join(', ')}) VALUES (${values.join(', ')})\n` +
		`ON CONFLICT(id) DO UPDATE SET title=excluded.title, title_short=excluded.title_short, ` +
		`artists=excluded.artists, album_title=excluded.album_title, cover_url=excluded.cover_url, ` +
		`release_year=excluded.release_year, genre=excluded.genre, decade=excluded.decade, ` +
		`answers=excluded.answers, preview_ms=excluded.preview_ms, fetched_at=excluded.fetched_at, ` +
		`unavailable_at=excluded.unavailable_at;`
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const artists = (await loadArtistList()).slice(0, ARTIST_LIMIT);
	process.stderr.write(
		`Seeding from ${artists.length} artist(s), up to ${PER_ARTIST_LIMIT} top tracks each ` +
			`(target: ${REMOTE ? 'REMOTE production D1' : 'local D1'}${SQL_ONLY ? ', SQL file only' : ''})\n`
	);

	const provider = new DeezerProvider();
	const seenIds = new Set<string>();
	const rows: TrackCacheRow[] = [];
	/** `"<deezer genre name>|<decade>"` → count, printed as a coverage report at the end. */
	const bucketCounts = new Map<string, number>();
	let refused = 0;

	for (let i = 0; i < artists.length; i++) {
		const artistName = artists[i];
		process.stderr.write(`[${i + 1}/${artists.length}] ${artistName}\n`);

		const artist = await provider.resolveArtistByName(artistName);
		if (!artist) {
			process.stderr.write(`  no Deezer artist match, skipping\n`);
			continue;
		}

		const pool = await provider.poolForFilters({
			seed: artistName,
			rounds: Math.ceil(PER_ARTIST_LIMIT / 3)
		});
		const candidates = pool.slice(0, PER_ARTIST_LIMIT);

		for (const candidate of candidates) {
			if (seenIds.has(candidate.providerId)) continue;
			seenIds.add(candidate.providerId);

			const hydrated = await provider.getTrack(candidate.providerId);
			if (!hydrated) continue;

			const previewUrl = await provider.getPreviewUrl(hydrated.providerId);
			if (!previewUrl) {
				refused++;
				continue;
			}

			const availability = await checkPreviewAvailability(previewUrl);
			if (!availability.ok) {
				refused++;
				continue;
			}

			const row = buildTrackCacheRow(hydrated, { previewMs: availability.durationMs });
			rows.push(row);

			const bucketKey = `${row.genre ?? '(none)'}|${row.decade ?? '(none)'}`;
			bucketCounts.set(bucketKey, (bucketCounts.get(bucketKey) ?? 0) + 1);
		}
	}

	process.stderr.write(
		`\nHydrated ${rows.length} track(s), refused ${refused} (dead/missing preview)\n`
	);
	process.stderr.write('\n=== Coverage by (genre, decade) ===\n');
	const sortedBuckets = [...bucketCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	for (const [bucket, count] of sortedBuckets) {
		const flag = count >= 20 ? 'OK' : 'THIN';
		process.stderr.write(`  ${bucket.padEnd(30)} ${String(count).padStart(4)}  ${flag}\n`);
	}

	if (rows.length === 0) {
		process.stderr.write('\nNothing to write — exiting.\n');
		return;
	}

	// D1 manages its own transactions and rejects explicit BEGIN/SAVEPOINT/COMMIT
	// statements from `wrangler d1 execute` (verified against local D1 while
	// building this script) — each upsert is independently atomic, which is
	// enough here since every statement is idempotent on its own.
	const sql = rows.map(upsertStatement).join('\n');
	await writeFile(SQL_OUTPUT_PATH, sql, 'utf-8');
	process.stderr.write(`\nWrote ${SQL_OUTPUT_PATH} (${rows.length} upserts)\n`);

	if (SQL_ONLY) {
		process.stderr.write(`--sql-only set — not applying. Apply manually with:\n`);
		process.stderr.write(
			`  npx wrangler d1 execute DB ${REMOTE ? '--remote' : '--local'} --file=${SQL_OUTPUT_PATH}\n`
		);
		return;
	}

	process.stderr.write(
		`Applying via wrangler d1 execute (${REMOTE ? '--remote' : '--local'})...\n`
	);
	const wranglerArgs = [
		'wrangler',
		'd1',
		'execute',
		'DB',
		REMOTE ? '--remote' : '--local',
		`--file=${SQL_OUTPUT_PATH}`
	];
	execFileSync('npx', wranglerArgs, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
	process.stderr.write('Done.\n');
}

// Re-exported for the smoke test in seed-cache.test.ts (SQL shape only — no network).
export { upsertStatement, sqlString, sqlNumber, sqlJson };
export type { TrackCacheRow };

// Guarded so `seed-cache.test.ts` can import the pure SQL-building helpers
// above without triggering a live run (§17: never hit the network in a test).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main().catch((err) => {
		process.stderr.write(
			`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
		);
		process.exitCode = 1;
	});
}
