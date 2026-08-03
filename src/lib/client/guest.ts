/**
 * Guest identity — technical-spec §4 "Guest identity" (ACC-1), §6 `game_session`,
 * §10 `POST /api/me/import-guest` (ACC-4).
 *
 * A guest is a `localStorage` blob: `{ guestId (nanoid), nickname, history[],
 * dailyStreak }`. Guests never touch the `user` table (§4) — the server only
 * ever sees the `x-guest-id` header (`src/lib/server/identity.ts`,
 * `readGuestId`/`guestIdSchema`) and, at write points, a nickname it
 * profanity-checks itself (FAIR-5). This module's job stops at *shape*
 * validity; it deliberately does not duplicate the server's profanity list.
 *
 * The whole app is guest-first (§4, §7.1 — sessions start with no account at
 * all until Phase 2's auth lands), so nothing here may throw: SSR has no
 * `localStorage`, private-mode Safari can throw on `setItem`, and a full quota
 * can too. Every failure degrades to an in-memory identity that lives for the
 * page lifetime rather than breaking play.
 */

import { z } from 'zod';
import { guestIdSchema, idSchema, nicknameSchema } from '../game/schemas.js';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface GuestHistoryEntry {
	sessionId: string;
	quizId: string;
	score: number;
	playedAt: number;
}

export interface GuestIdentity {
	guestId: string;
	nickname: string | null;
	history: GuestHistoryEntry[];
	dailyStreak: { count: number; lastDay: string | null };
}

/** Most-recent entries kept locally — unbounded growth would sit in every page load forever. */
const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Storage — key is versioned so a future shape change can migrate a known
// `schemaVersion` rather than crash on an old blob; an unrecognized version is
// treated the same as corrupt JSON (discard, start fresh — no migration path
// exists yet because this is the only version that has ever shipped).
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'devinyl:guest:v1';
const SCHEMA_VERSION = 1;

const historyEntrySchema = z.object({
	sessionId: idSchema,
	quizId: idSchema,
	score: z.number().int().min(0),
	playedAt: z.number().int().min(0)
});

const storedGuestSchema = z.object({
	schemaVersion: z.literal(SCHEMA_VERSION),
	guestId: guestIdSchema,
	nickname: nicknameSchema.nullable(),
	history: z.array(historyEntrySchema),
	dailyStreak: z.object({
		count: z.number().int().min(0),
		lastDay: z.string().nullable()
	})
});

/** Minimal `localStorage` surface, mirroring `preloader.ts`'s `StorageLike` — lets tests stub it. */
interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * Probes for a working `localStorage`: absent entirely (SSR), or present but
 * throwing on write (Safari private mode, exhausted quota) both resolve to
 * `null` here so every caller has one place to fall back to memory.
 */
function getStorage(): StorageLike | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		const probeKey = '__devinyl_storage_probe__';
		localStorage.setItem(probeKey, '1');
		localStorage.removeItem(probeKey);
		return localStorage;
	} catch {
		return null;
	}
}

/** Same alphabet/approach as `src/lib/server/ids.ts` (nanoid without the dependency). */
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 16 chars: comfortably inside `guestIdSchema`'s 8–32 range. */
function newGuestId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let id = '';
	for (const byte of bytes) id += ID_ALPHABET[byte & 63];
	return id;
}

function freshIdentity(): GuestIdentity {
	return {
		guestId: newGuestId(),
		nickname: null,
		history: [],
		dailyStreak: { count: 0, lastDay: null }
	};
}

// In-memory fallback for the page lifetime (SSR, private mode, quota) — and
// the single-flight cache that makes repeated `loadGuest()` calls stable
// without re-parsing storage every time.
let cached: GuestIdentity | null = null;

function persist(g: GuestIdentity): void {
	const storage = getStorage();
	if (!storage) return;
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...g }));
	} catch {
		// Quota exceeded or storage revoked mid-session — keep playing from the
		// in-memory copy already held in `cached`.
	}
}

function readFromStorage(): GuestIdentity | null {
	const storage = getStorage();
	if (!storage) return null;
	const raw = storage.getItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		const parsed = storedGuestSchema.parse(JSON.parse(raw));
		const { schemaVersion: _schemaVersion, ...identity } = parsed;
		return identity;
	} catch {
		// Corrupt JSON, or a shape this build doesn't recognize — never throw,
		// just start fresh (comment above on `STORAGE_KEY`).
		return null;
	}
}

/** Loads the guest identity, creating and persisting one on first call. Never throws. */
export function loadGuest(): GuestIdentity {
	if (cached) return cached;
	const existing = readFromStorage();
	cached = existing ?? freshIdentity();
	if (!existing) persist(cached);
	return cached;
}

/** Replaces the stored identity wholesale. Callers normally go through the helpers below instead. */
export function saveGuest(g: GuestIdentity): void {
	cached = g;
	persist(g);
}

/** Sets the nickname shown on boards (FAIR-5's actual filtering happens server-side, at write time). */
export function setNickname(name: string): GuestIdentity {
	const g = { ...loadGuest(), nickname: name };
	saveGuest(g);
	return g;
}

/** Appends a completed session to local history, capped at `MAX_HISTORY` most recent. */
export function recordPlay(entry: GuestHistoryEntry): GuestIdentity {
	const current = loadGuest();
	const g: GuestIdentity = {
		...current,
		history: [entry, ...current.history].slice(0, MAX_HISTORY)
	};
	saveGuest(g);
	return g;
}

/** `YYYY-MM-DD` arithmetic on a calendar-day string — no timezone conversion needed here. */
function dayBefore(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

/**
 * Updates the daily streak for having played on `parisDay` (the caller
 * computes this via `src/lib/server/time.ts`'s `parisDay()` server-side, or
 * an equivalent client read of the server's response — this module only
 * compares the strings it's given, per DAILY-4 / technical-spec §11):
 *
 *   - same day as last recorded play → no-op (already counted today);
 *   - `lastDay` is the calendar day immediately before `parisDay` → streak++;
 *   - anything else (gap, or first-ever daily) → reset to 1.
 */
export function recordDailyPlay(parisDay: string): GuestIdentity {
	const current = loadGuest();
	const { count, lastDay } = current.dailyStreak;
	if (lastDay === parisDay) return current;

	const nextCount = lastDay !== null && dayBefore(parisDay) === lastDay ? count + 1 : 1;
	const g: GuestIdentity = {
		...current,
		dailyStreak: { count: nextCount, lastDay: parisDay }
	};
	saveGuest(g);
	return g;
}

/** The header set every request needs to be recognized as this guest (`src/lib/server/identity.ts`). */
export function guestHeaders(): Record<string, string> {
	return { 'x-guest-id': loadGuest().guestId };
}
