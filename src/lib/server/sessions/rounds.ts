/**
 * Round-start beacons and round results — technical-spec §7.1/§7.2, task 1.15.
 *
 * The beacon exists for one purpose: to give the server its **own** timestamp
 * for when a round began, which is the entire basis of the verified
 * plausibility tier (§7.3). It is fire-and-forget and **returns nothing** —
 * §7.2 (v1.1) moved round keys to client-side HKDF precisely so that nothing on
 * the play path waits for a network round-trip, and the stale §10 endpoint
 * table still describing a returned key is a documented spec inconsistency
 * (plan §G-1).
 *
 * A beacon that never arrives is normal, not suspicious: MUS-7 promises play
 * survives a connection drop, and a drop means no beacons. The client queues
 * them and flushes with the next result; both paths land in the same
 * `server_round_log`, with `queued` recorded so finalize can tell a
 * server-observed timestamp from a client-reported one.
 */

import { eq, sql } from 'drizzle-orm';
import type { RoundResultBody } from '$lib/game/schemas.js';
import type { Db } from '../db/index.js';
import { gameSession, roundResult } from '../db/schema.js';

type SessionRow = typeof gameSession.$inferSelect;

/**
 * Record a server-observed round start. Idempotent per position — a client
 * retrying a beacon must not be able to rewrite the first observation, which
 * would let it push the window later and buy time.
 */
export async function recordBeacon(
	db: Db,
	session: SessionRow,
	position: number,
	at: number = Date.now()
): Promise<void> {
	const log = session.serverRoundLog ?? [];
	if (log.some((entry) => entry.position === position)) return;

	await db
		.update(gameSession)
		.set({ serverRoundLog: [...log, { position, at }] })
		.where(eq(gameSession.id, session.id));
}

/**
 * Merge beacons that failed during an offline stretch (§4). Kept distinct from
 * `recordBeacon` because these timestamps are *client-reported elapsed offsets*
 * reconstructed against the result's arrival, not server observations — they
 * are enough to place a round in the reconstructed tier, and deliberately never
 * enough to earn the verified one. A position the server already observed
 * always wins.
 */
export async function mergeQueuedBeacons(
	db: Db,
	session: SessionRow,
	queued: { position: number; atMs: number }[],
	receivedAt: number
): Promise<void> {
	if (queued.length === 0) return;

	const log = [...(session.serverRoundLog ?? [])];
	const seen = new Set(log.map((entry) => entry.position));
	let changed = false;

	for (const beacon of queued) {
		if (seen.has(beacon.position)) continue;
		seen.add(beacon.position);
		// Reconstructed, not observed: the offset is relative to receipt.
		log.push({ position: beacon.position, at: receivedAt - beacon.atMs });
		changed = true;
	}

	if (changed) {
		await db.update(gameSession).set({ serverRoundLog: log }).where(eq(gameSession.id, session.id));
	}
}

/**
 * Store one round's **raw** result. Nothing here is scored or trusted: the
 * client's claimed lock times go into their own `claimed_*` columns, and
 * `title_ms`/`artist_ms`/`points` stay null until finalize recomputes them from
 * the guess log (§7.3 step 1). Keeping the two apart is what lets finalize
 * notice a client claiming a lock the server can't reproduce.
 *
 * Upsert rather than insert: a result POST that times out and is retried must
 * not 409 in the player's face mid-quiz.
 */
export async function recordRoundResult(
	db: Db,
	session: SessionRow,
	body: RoundResultBody,
	receivedAt: number = Date.now()
): Promise<void> {
	const values = {
		sessionId: session.id,
		position: body.position,
		titleOk: null,
		artistOk: null,
		skipped: body.skipped,
		clipMs: body.clipMs,
		titleMs: null,
		artistMs: null,
		points: 0,
		guessLog: body.guessLog,
		claimedTitleMs: body.lockTimes.title ?? null,
		claimedArtistMs: body.lockTimes.artist ?? null,
		serverReceivedAt: receivedAt
	};

	await db
		.insert(roundResult)
		.values(values)
		.onConflictDoUpdate({
			target: [roundResult.sessionId, roundResult.position],
			set: {
				skipped: values.skipped,
				clipMs: values.clipMs,
				guessLog: values.guessLog,
				claimedTitleMs: values.claimedTitleMs,
				claimedArtistMs: values.claimedArtistMs,
				serverReceivedAt: values.serverReceivedAt
			}
		});
}

/** Rounds for a session, in play order — the input finalize re-validates. */
export async function loadRoundResults(db: Db, sessionId: string) {
	return db
		.select()
		.from(roundResult)
		.where(eq(roundResult.sessionId, sessionId))
		.orderBy(sql`${roundResult.position} ASC`);
}
