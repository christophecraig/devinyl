/**
 * Availability re-check against real D1 — technical-spec §5.3, MUS-5, plan
 * task 4.2. Same harness as `sweep.integration.test.ts`
 * (`@cloudflare/vitest-pool-workers` + `test-utils.integration.ts`), because
 * every property under test here is a property of a *query*: which tracks the
 * cursor picks, which `daily_quiz` rows are in scope, and what the update's
 * `isNull` guard protects.
 *
 * Nothing here touches the network: the catalog side is `FakeCatalogProvider`
 * (whose `failPreviewFor` is a takedown) and the ranged GET is a stub `fetch`.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyQuiz, trackCache } from '../db/schema.js';
import { parisDay, parisDayOffset } from '../time.js';
import {
	FakeCatalogProvider,
	createQuiz,
	createUser,
	ensureMigrations,
	resetDb,
	testDb
} from '../test-utils.integration.js';
import { disqualifyUpcomingDailySlots, runAvailabilityRecheck } from './availability.js';

const db = testDb();
const NOW = Date.parse('2026-08-05T09:00:00Z');

/**
 * A `fetch` that answers every ranged GET the way a healthy Deezer preview
 * does: 206 with the `content-range` `checkPreviewAvailability` parses into a
 * ~30 s duration. A dead clip never reaches this stub — `FakeCatalogProvider`
 * resolves its preview URL to `null` first, which is the takedown signal.
 */
function healthyFetch(): typeof fetch {
	return vi.fn(
		async () =>
			new Response(new Uint8Array(2), {
				status: 206,
				headers: { 'content-range': 'bytes 0-1/479827' }
			})
	) as unknown as typeof fetch;
}

/** A `fetch` that 404s — the other shape of takedown (URL resolves, clip is gone). */
function goneFetch(): typeof fetch {
	return vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
}

/** `display_name_normalized` is unique (ACC-5), so every fixture user needs its own name. */
function operatorFixture(handle: string) {
	return {
		email: `${handle}@example.test`,
		displayName: handle,
		displayNameNormalized: handle,
		isOperator: true
	};
}

beforeAll(async () => {
	await ensureMigrations();
});

beforeEach(async () => {
	await resetDb(db);
});

describe('runAvailabilityRecheck — takedown marking (§5.3)', () => {
	it('stamps unavailable_at on a track whose preview no longer resolves', async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 2, kind: 'official' });
		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(tracks[0].id);
		expect(quizRow.kind).toBe('official');

		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: vi.fn()
		});

		expect(result.checked).toBe(2);
		expect(result.newlyUnavailable.map((t) => t.id)).toEqual([tracks[0].id]);

		const [dead] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[0].id));
		expect(dead.unavailableAt).toBe(NOW);

		// The healthy sibling is left available, and its fetched_at is restamped —
		// that restamp is the rotation cursor (see the module header).
		const [alive] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[1].id));
		expect(alive.unavailableAt).toBeNull();
		expect(alive.fetchedAt).toBe(NOW);
	});

	it('marks a track whose preview URL resolves but whose clip 404s', async () => {
		const { tracks } = await createQuiz(db, { trackCount: 1, kind: 'official' });

		const result = await runAvailabilityRecheck({
			db,
			provider: new FakeCatalogProvider(),
			now: NOW,
			scope: 'official',
			fetchImpl: goneFetch(),
			sendEmailImpl: vi.fn()
		});

		expect(result.newlyUnavailable.map((t) => t.id)).toEqual([tracks[0].id]);
	});

	it('preserves the original timestamp on a track already marked unavailable', async () => {
		const earlier = NOW - 3 * 24 * 60 * 60 * 1000;
		const { tracks } = await createQuiz(db, { trackCount: 1, kind: 'official' });
		await db
			.update(trackCache)
			.set({ unavailableAt: earlier })
			.where(eq(trackCache.id, tracks[0].id));

		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(tracks[0].id);

		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: vi.fn()
		});

		// Not even re-probed: this job only moves tracks available → unavailable.
		expect(result.checked).toBe(0);
		expect(result.newlyUnavailable).toEqual([]);

		const [row] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[0].id));
		expect(row.unavailableAt).toBe(earlier);
	});

	it('leaves a track alone when the probe is inconclusive (5xx), rather than declaring it dead', async () => {
		const { tracks } = await createQuiz(db, { trackCount: 1, kind: 'official' });
		const flakyFetch = vi.fn(
			async () => new Response(null, { status: 503 })
		) as unknown as typeof fetch;

		const result = await runAvailabilityRecheck({
			db,
			provider: new FakeCatalogProvider(),
			now: NOW,
			scope: 'official',
			fetchImpl: flakyFetch,
			sendEmailImpl: vi.fn()
		});

		expect(result.newlyUnavailable).toEqual([]);
		const [row] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[0].id));
		expect(row.unavailableAt).toBeNull();
	});
});

describe('runAvailabilityRecheck — scope (§5.3 nightly vs weekly)', () => {
	it('the official pass ignores user-owned quizzes', async () => {
		const owner = await createUser(db);
		const { tracks } = await createQuiz(db, { trackCount: 1, kind: 'manual', ownerId: owner.id });
		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(tracks[0].id);

		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: vi.fn()
		});

		expect(result.checked).toBe(0);
	});

	it('the user pass covers manual/generated quizzes and only stamps the column (MUS-5 does the rest)', async () => {
		const owner = await createUser(db);
		const { tracks } = await createQuiz(db, { trackCount: 1, kind: 'manual', ownerId: owner.id });
		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(tracks[0].id);

		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'user',
			fetchImpl: healthyFetch(),
			sendEmailImpl: vi.fn()
		});

		expect(result.newlyUnavailable.map((t) => t.id)).toEqual([tracks[0].id]);
		expect(result.disqualifiedDays).toEqual([]);
	});

	it('covers a quiz scheduled into an upcoming daily slot even before it is published official', async () => {
		// scheduleDaily() refuses a non-official quiz, but a row can exist from an
		// earlier publication whose kind was later edited; the point of the
		// lookahead clause is that daily-slot membership alone puts a quiz in scope.
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, kind: 'manual' });
		await db.insert(dailyQuiz).values({
			day: parisDayOffset(NOW, 5),
			quizId: quizRow.id,
			dayNumber: 1
		});
		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(tracks[0].id);

		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: vi.fn()
		});

		expect(result.checked).toBe(1);
		expect(result.newlyUnavailable).toHaveLength(1);
	});
});

describe('daily-slot disqualification (§5.3 — ahead of play, not after it)', () => {
	it('clears an upcoming slot whose quiz has a dead track and leaves past slots alone', async () => {
		const past = await createQuiz(db, { trackCount: 1, kind: 'official' });
		const upcoming = await createQuiz(db, { trackCount: 2, kind: 'official' });

		const yesterday = parisDayOffset(NOW, -1);
		const tomorrow = parisDayOffset(NOW, 1);
		await db.insert(dailyQuiz).values([
			{ day: yesterday, quizId: past.quiz.id, dayNumber: 1 },
			{ day: tomorrow, quizId: upcoming.quiz.id, dayNumber: 2 }
		]);

		// The same track sits in both quizzes' first position (createQuiz walks
		// FIXTURE_TRACKS in order), so one takedown threatens both slots — and
		// only the future one may be cleared.
		expect(past.tracks[0].id).toBe(upcoming.tracks[0].id);

		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(upcoming.tracks[0].id);

		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: vi.fn()
		});

		expect(result.disqualifiedDays).toEqual([tomorrow]);

		const remaining = await db.select({ day: dailyQuiz.day }).from(dailyQuiz);
		expect(remaining.map((r) => r.day)).toEqual([yesterday]);
	});

	it("clears today's slot too — a mid-day takedown voids every session that hits it (MUS-5)", async () => {
		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 1, kind: 'official' });
		const today = parisDay(NOW);
		await db.insert(dailyQuiz).values({ day: today, quizId: quizRow.id, dayNumber: 1 });
		await db
			.update(trackCache)
			.set({ unavailableAt: NOW - 1 })
			.where(eq(trackCache.id, tracks[0].id));

		expect(await disqualifyUpcomingDailySlots(db, NOW)).toEqual([today]);
		expect(await db.select().from(dailyQuiz)).toHaveLength(0);
	});

	it('leaves a healthy upcoming slot scheduled', async () => {
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 1, kind: 'official' });
		const tomorrow = parisDayOffset(NOW, 1);
		await db.insert(dailyQuiz).values({ day: tomorrow, quizId: quizRow.id, dayNumber: 1 });

		expect(await disqualifyUpcomingDailySlots(db, NOW)).toEqual([]);
		expect(await db.select().from(dailyQuiz)).toHaveLength(1);
	});
});

describe('operator alerts (§G-5)', () => {
	it('emails every operator exactly once for the whole incident batch', async () => {
		// Distinct display names: `display_name_normalized` is unique (ACC-5).
		await createUser(db, operatorFixture('op1'));
		await createUser(db, operatorFixture('op2'));
		await createUser(db, { ...operatorFixture('player'), isOperator: false });

		const { quiz: quizRow, tracks } = await createQuiz(db, { trackCount: 2, kind: 'official' });
		await db.insert(dailyQuiz).values({
			day: parisDayOffset(NOW, 2),
			quizId: quizRow.id,
			dayNumber: 1
		});

		const provider = new FakeCatalogProvider();
		provider.failPreviewFor(tracks[0].id);
		provider.failPreviewFor(tracks[1].id);

		const send = vi.fn();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await runAvailabilityRecheck({
			db,
			provider,
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: send
		});
		errorSpy.mockRestore();

		expect(result.newlyUnavailable).toHaveLength(2);
		expect(result.disqualifiedDays).toHaveLength(1);
		// Two dead tracks + one cleared slot ⇒ still one email per operator.
		expect(send).toHaveBeenCalledTimes(2);
		expect(result.alerted.sort()).toEqual(['op1@example.test', 'op2@example.test']);
		// The non-operator is never told.
		const recipients = send.mock.calls.map((call) => (call[1] as { to: string }).to);
		expect(recipients).not.toContain('player@example.test');
	});

	it('a no-op run alerts nobody', async () => {
		await createUser(db, operatorFixture('op'));
		const { quiz: quizRow } = await createQuiz(db, { trackCount: 2, kind: 'official' });
		await db.insert(dailyQuiz).values({
			day: parisDayOffset(NOW, 2),
			quizId: quizRow.id,
			dayNumber: 1
		});

		const send = vi.fn();
		const result = await runAvailabilityRecheck({
			db,
			provider: new FakeCatalogProvider(),
			now: NOW,
			scope: 'official',
			fetchImpl: healthyFetch(),
			sendEmailImpl: send
		});

		expect(result.checked).toBe(2);
		expect(result.newlyUnavailable).toEqual([]);
		expect(result.disqualifiedDays).toEqual([]);
		expect(result.alerted).toEqual([]);
		expect(send).not.toHaveBeenCalled();
		expect(await db.select().from(dailyQuiz)).toHaveLength(1);
	});
});

describe('bounded work + rotation cursor', () => {
	it('processes at most batchSize tracks per run, oldest fetched_at first, so every track eventually cycles', async () => {
		const { tracks } = await createQuiz(db, { trackCount: 3, kind: 'official' });
		// Stagger fetched_at so the cursor has a defined order to follow.
		for (let i = 0; i < tracks.length; i++) {
			await db
				.update(trackCache)
				.set({ fetchedAt: 1_000 + i })
				.where(eq(trackCache.id, tracks[i].id));
		}

		const run = () =>
			runAvailabilityRecheck({
				db,
				provider: new FakeCatalogProvider(),
				now: NOW,
				scope: 'official',
				fetchImpl: healthyFetch(),
				sendEmailImpl: vi.fn(),
				batchSize: 1
			});

		expect((await run()).checked).toBe(1);
		// The first run restamped track 0 to NOW, pushing it to the back of the
		// queue; the next run therefore picks up track 1, and so on.
		const [first] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[0].id));
		expect(first.fetchedAt).toBe(NOW);

		await run();
		const [second] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[1].id));
		expect(second.fetchedAt).toBe(NOW);

		await run();
		const [third] = await db.select().from(trackCache).where(eq(trackCache.id, tracks[2].id));
		expect(third.fetchedAt).toBe(NOW);
	});
});
