import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gameSession, quiz, quizTrack, dailyGuestClaim, rateLimit } from '../db/schema.js';
import { getDb } from '../db/index.js';
import {
	purgeDailyGuestClaims,
	purgeRateLimitWindows,
	runJobs,
	sweepAbandonedSessions,
	sweepEphemeralQuizzes
} from './index';

// getDb wraps the D1 binding; runJobs itself has no D1-backed unit-test
// harness (that lives in *.integration.test.ts under miniflare), so every
// `runJobs` test below swaps in the fake `Db` from `createFakeDb`.
vi.mock('../db/index.js', () => ({ getDb: vi.fn() }));

/**
 * A minimal stand-in for the chainable Drizzle query builder. It doesn't
 * interpret the SQL conditions it's handed — `and`/`eq`/`lt`/`notExists`
 * etc. are the real drizzle-orm builders and only ever produce inert SQL
 * fragments here, never executed — it just records which table each
 * select/update/delete targeted and resolves selects to a queued canned
 * result, so each job's *wiring* (what it reads, what it writes) can be
 * asserted without a real database underneath it.
 */
function createFakeDb() {
	const selectResults: unknown[][] = [];
	const selectCalls: unknown[] = [];
	const updateCalls: { table: unknown; set: unknown }[] = [];
	const deleteCalls: { table: unknown }[] = [];

	function chain(result: unknown) {
		const builder: PromiseLike<unknown> & Record<string, unknown> = {
			from: vi.fn(() => builder),
			where: vi.fn(() => builder),
			limit: vi.fn(() => builder),
			set: vi.fn(() => builder),
			then: (
				onFulfilled?: ((value: unknown) => unknown) | null,
				onRejected?: ((reason: unknown) => unknown) | null
			) => Promise.resolve(result).then(onFulfilled, onRejected)
		} as unknown as PromiseLike<unknown> & Record<string, unknown>;
		return builder;
	}

	const db = {
		select: vi.fn(() => {
			selectCalls.push(true);
			// Every select — including the notExists() leaf-safety subqueries,
			// which are built but never awaited — gets the next queued result.
			// Only the awaited (outer) one ever consumes it.
			const result = selectResults.length > 0 ? selectResults[0] : [];
			return chain(result);
		}),
		update: vi.fn((table: unknown) => {
			const builder = chain(undefined);
			builder.set = vi.fn((setArg: unknown) => {
				updateCalls.push({ table, set: setArg });
				return builder;
			});
			return builder;
		}),
		delete: vi.fn((table: unknown) => {
			deleteCalls.push({ table });
			return chain(undefined);
		})
	};

	return {
		db: db as unknown as Parameters<typeof sweepAbandonedSessions>[0],
		/** Queue the array the *next* outer (awaited) select() resolves to. */
		queueSelect(result: unknown[]) {
			selectResults.length = 0;
			selectResults.push(result);
		},
		selectCalls,
		updateCalls,
		deleteCalls
	};
}

describe('sweepAbandonedSessions (ROUND-8)', () => {
	it('moves stale active sessions to abandoned without scoring them', async () => {
		const { db, queueSelect, updateCalls } = createFakeDb();
		queueSelect([{ id: 's1' }, { id: 's2' }]);

		const count = await sweepAbandonedSessions(db, Date.now());

		expect(count).toBe(2);
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].table).toBe(gameSession);
		expect(updateCalls[0].set).toEqual({ status: 'abandoned' });
	});

	it('does not write when nothing is stale', async () => {
		const { db, queueSelect, updateCalls } = createFakeDb();
		queueSelect([]);

		const count = await sweepAbandonedSessions(db, Date.now());

		expect(count).toBe(0);
		expect(updateCalls).toHaveLength(0);
	});
});

describe('sweepEphemeralQuizzes (§6 leaf-only sweep)', () => {
	it('deletes quiz_track children before the parent quiz row', async () => {
		const { db, queueSelect, deleteCalls } = createFakeDb();
		queueSelect([{ id: 'q1' }]);

		const count = await sweepEphemeralQuizzes(db, Date.now());

		expect(count).toBe(1);
		expect(deleteCalls).toHaveLength(2);
		expect(deleteCalls[0].table).toBe(quizTrack);
		expect(deleteCalls[1].table).toBe(quiz);
	});

	it('deletes nothing when there are no expired leaf quizzes', async () => {
		const { db, queueSelect, deleteCalls } = createFakeDb();
		queueSelect([]);

		const count = await sweepEphemeralQuizzes(db, Date.now());

		expect(count).toBe(0);
		expect(deleteCalls).toHaveLength(0);
	});
});

describe('purgeDailyGuestClaims (FAIR-7, 48h)', () => {
	it('deletes every claim past the retention window', async () => {
		const { db, queueSelect, deleteCalls } = createFakeDb();
		queueSelect([
			{ day: '2026-08-01', ipHash: 'h1' },
			{ day: '2026-08-01', ipHash: 'h2' }
		]);

		const count = await purgeDailyGuestClaims(db, Date.now());

		expect(count).toBe(2);
		expect(deleteCalls).toHaveLength(2);
		expect(deleteCalls.every((c) => c.table === dailyGuestClaim)).toBe(true);
	});
});

describe('purgeRateLimitWindows (§10 counter cleanup)', () => {
	it('deletes windows older than the margin', async () => {
		const { db, queueSelect, deleteCalls } = createFakeDb();
		queueSelect([{ key: 'session_create:guest_1', windowStart: 1000 }]);

		const count = await purgeRateLimitWindows(db, Date.now());

		expect(count).toBe(1);
		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0].table).toBe(rateLimit);
	});
});

describe('runJobs', () => {
	beforeEach(() => {
		vi.mocked(getDb).mockReset();
	});

	it('resolves without throwing for every declared kind', async () => {
		const { db } = createFakeDb();
		vi.mocked(getDb).mockReturnValue(db as never);
		const fakePlatform = {} as App.Platform;

		await expect(runJobs('every-15-min', fakePlatform)).resolves.toBeUndefined();
		await expect(runJobs('hourly', fakePlatform)).resolves.toBeUndefined();
		await expect(runJobs('daily', fakePlatform)).resolves.toBeUndefined();
	});

	it('isolates a failing job so the rest of the every-15-min batch still runs', async () => {
		// A db whose select() always throws simulates one job's query failing;
		// runJobs must still resolve (worker/entry.ts's own catch is only a
		// last resort for the whole batch, not a substitute for per-job safety).
		const throwingDb = {
			select: vi.fn(() => {
				throw new Error('boom');
			}),
			update: vi.fn(),
			delete: vi.fn()
		};
		vi.mocked(getDb).mockReturnValue(throwingDb as never);

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(runJobs('every-15-min', {} as App.Platform)).resolves.toBeUndefined();

		// All four jobs reported a failure rather than one throw taking the batch
		// down, and none reached the point of writing.
		expect(errorSpy).toHaveBeenCalledTimes(4);
		expect(throwingDb.update).not.toHaveBeenCalled();
		expect(throwingDb.delete).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('isolates a failing job in the hourly batch too', async () => {
		const throwingDb = {
			select: vi.fn(() => {
				throw new Error('boom');
			}),
			update: vi.fn(),
			delete: vi.fn()
		};
		vi.mocked(getDb).mockReturnValue(throwingDb as never);

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(runJobs('hourly', {} as App.Platform)).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(throwingDb.delete).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
