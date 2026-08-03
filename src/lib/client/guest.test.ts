/**
 * Unit tests for guest identity (src/lib/client/guest.ts): technical-spec §4
 * "Guest identity" (ACC-1) and DAILY-4 streak semantics.
 *
 * Each test gets a fresh module instance via `vi.resetModules()` + dynamic
 * `import()` because the module keeps an in-memory singleton (`cached`) that
 * must not leak between tests — the same reason production code caches it at
 * all (stable identity across calls without re-parsing storage every time).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size;
		}
	} as Storage;
}

async function freshGuestModule() {
	vi.resetModules();
	return import('./guest.js');
}

beforeEach(() => {
	// @ts-expect-error -- node test env has no global localStorage by default.
	delete globalThis.localStorage;
});

describe('loadGuest — first-call creation', () => {
	it('creates and persists a guest identity, stable across repeated calls', async () => {
		globalThis.localStorage = memoryStorage();
		const { loadGuest } = await freshGuestModule();

		const first = loadGuest();
		const second = loadGuest();

		expect(first.guestId).toBeTruthy();
		expect(first.guestId).toBe(second.guestId);
		expect(first.nickname).toBeNull();
		expect(first.history).toEqual([]);
		expect(first.dailyStreak).toEqual({ count: 0, lastDay: null });

		const stored = JSON.parse(globalThis.localStorage.getItem('devinyl:guest:v1') as string);
		expect(stored.guestId).toBe(first.guestId);
		expect(stored.schemaVersion).toBe(1);
	});

	it('is stable across separate module instances that share the same storage', async () => {
		globalThis.localStorage = memoryStorage();
		const mod1 = await freshGuestModule();
		const id1 = mod1.loadGuest().guestId;

		const mod2 = await freshGuestModule();
		const id2 = mod2.loadGuest().guestId;

		expect(id2).toBe(id1);
	});
});

describe('loadGuest — corrupt storage recovery', () => {
	it('discards unparseable JSON and starts fresh instead of throwing', async () => {
		const storage = memoryStorage();
		storage.setItem('devinyl:guest:v1', '{not json');
		globalThis.localStorage = storage;
		const { loadGuest } = await freshGuestModule();

		expect(() => loadGuest()).not.toThrow();
		const g = loadGuest();
		expect(g.guestId).toBeTruthy();
	});

	it('discards a stored blob with an unrecognized schema shape', async () => {
		const storage = memoryStorage();
		storage.setItem('devinyl:guest:v1', JSON.stringify({ schemaVersion: 99, foo: 'bar' }));
		globalThis.localStorage = storage;
		const { loadGuest } = await freshGuestModule();

		const g = loadGuest();
		expect(g.guestId).toBeTruthy();
		expect(g.history).toEqual([]);
	});
});

describe('loadGuest — no localStorage available (SSR, private mode)', () => {
	it('degrades to an in-memory identity rather than throwing', async () => {
		// No globalThis.localStorage at all — simulates SSR.
		const { loadGuest, setNickname, guestHeaders } = await freshGuestModule();

		expect(() => loadGuest()).not.toThrow();
		const first = loadGuest();
		const second = loadGuest();
		expect(first.guestId).toBe(second.guestId);

		expect(() => setNickname('Alex')).not.toThrow();
		expect(guestHeaders()).toEqual({ 'x-guest-id': first.guestId });
	});

	it('degrades to memory when setItem throws (quota exceeded / Safari private mode)', async () => {
		globalThis.localStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0
		} as Storage;
		const { loadGuest } = await freshGuestModule();

		expect(() => loadGuest()).not.toThrow();
		const first = loadGuest();
		const second = loadGuest();
		expect(first.guestId).toBe(second.guestId);
	});
});

describe('recordPlay — history cap', () => {
	it('keeps only the 50 most recent entries, newest first', async () => {
		globalThis.localStorage = memoryStorage();
		const { loadGuest, recordPlay } = await freshGuestModule();
		loadGuest();

		let g = loadGuest();
		for (let i = 0; i < 55; i++) {
			g = recordPlay({
				// idSchema requires exactly 12 chars — `s` + 11 zero-padded digits.
				sessionId: `s${String(i).padStart(11, '0')}`,
				quizId: `q${String(i).padStart(11, '0')}`,
				score: i,
				playedAt: i
			});
		}

		expect(g.history).toHaveLength(50);
		// Newest (i = 54) first, oldest kept is i = 5 (55 - 50).
		expect(g.history[0].score).toBe(54);
		expect(g.history.at(-1)?.score).toBe(5);
	});
});

describe('recordDailyPlay — DAILY-4 streak', () => {
	it('increments when the previous play was exactly the day before', async () => {
		globalThis.localStorage = memoryStorage();
		const { recordDailyPlay } = await freshGuestModule();

		recordDailyPlay('2026-08-01');
		const g = recordDailyPlay('2026-08-02');

		expect(g.dailyStreak).toEqual({ count: 2, lastDay: '2026-08-02' });
	});

	it('resets to 1 when there is a gap since the previous play', async () => {
		globalThis.localStorage = memoryStorage();
		const { recordDailyPlay } = await freshGuestModule();

		recordDailyPlay('2026-08-01');
		const g = recordDailyPlay('2026-08-05');

		expect(g.dailyStreak).toEqual({ count: 1, lastDay: '2026-08-05' });
	});

	it('is a no-op when called again for the same day', async () => {
		globalThis.localStorage = memoryStorage();
		const { recordDailyPlay } = await freshGuestModule();

		recordDailyPlay('2026-08-01');
		recordDailyPlay('2026-08-01');
		const g = recordDailyPlay('2026-08-01');

		expect(g.dailyStreak).toEqual({ count: 1, lastDay: '2026-08-01' });
	});

	it('starts a fresh streak of 1 on the very first daily play', async () => {
		globalThis.localStorage = memoryStorage();
		const { recordDailyPlay } = await freshGuestModule();

		const g = recordDailyPlay('2026-08-01');
		expect(g.dailyStreak).toEqual({ count: 1, lastDay: '2026-08-01' });
	});
});

describe('guestHeaders', () => {
	it('carries the current guestId as x-guest-id', async () => {
		globalThis.localStorage = memoryStorage();
		const { loadGuest, guestHeaders } = await freshGuestModule();

		const g = loadGuest();
		expect(guestHeaders()).toEqual({ 'x-guest-id': g.guestId });
	});
});
