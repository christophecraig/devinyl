/**
 * Availability re-check — technical-spec §5.3/§15, MUS-5, plan task 4.2.
 *
 * §5.3: "A nightly job refreshes `track_cache` rows referenced by official and
 * daily quizzes and re-checks preview availability. A detected takedown stamps
 * `unavailable_at`, alerts the operator, and disqualifies the affected quiz
 * from being served as that day's daily — MUS-5 makes a mid-day takedown
 * expensive (every session touching it goes unscored), so detection has to run
 * ahead of play, not after it. User quizzes are re-checked weekly."
 *
 * Three things this module is careful about:
 *
 *   1. **It never deletes catalog data.** A takedown stamps
 *      `track_cache.unavailable_at` and stops there — `sessions/create.ts`
 *      already turns that column into a skipped round (MUS-5), and finalize
 *      turns a skipped round into `clip_unavailable` (FAIR-6). An already-set
 *      `unavailable_at` is never overwritten: the *first* observation is the
 *      useful one for an operator reading the `/admin` banner.
 *
 *   2. **It distinguishes "gone" from "couldn't tell".** A transport failure or
 *      a 5xx is inconclusive and marks nothing — spuriously flagging a track
 *      dead costs a daily slot (see the disqualification below), so the bar for
 *      writing `unavailable_at` is an *answer* from the provider, not the
 *      absence of one. See `verdictFor`.
 *
 *   3. **Work per tick is bounded, with a cursor that guarantees rotation.**
 *      There is no `last_checked_at` column and task 4.2 forbids a migration,
 *      so `fetched_at` doubles as the cursor: candidates are taken
 *      oldest-`fetched_at`-first and a successful check restamps `fetched_at`
 *      (legitimately — the check *is* a provider round-trip that re-reads the
 *      track, and it refreshes `preview_ms` from the measured duration). Every
 *      track therefore reaches the front of the queue eventually, however large
 *      the catalog grows relative to `AVAILABILITY_BATCH_SIZE`.
 */

import { and, asc, eq, exists, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { dailyQuiz, quiz, quizTrack, trackCache, user } from '../db/schema.js';
import type { CatalogProvider } from '../catalog/provider.js';
import { checkPreviewAvailability, type PreviewCheckResult } from '../catalog/availability.js';
import { sendEmail } from '../email.js';
import { parisDay, parisDayOffset } from '../time.js';

/**
 * Tracks probed per run. Deliberately far below `jobs/index.ts`'s
 * `BATCH_SIZE` of 200: each candidate costs **two** subrequests (one
 * `/track/{id}` to re-resolve the short-lived preview URL, one ranged GET
 * against the CDN clip), and the Workers Free plan caps a single invocation at
 * 50 subrequests. 20 candidates ≈ 40 subrequests leaves headroom for the
 * batch's other jobs on the same tick.
 */
const AVAILABILITY_BATCH_SIZE = 20;

/**
 * Matches `getDailyCalendar`'s admin lookahead (and 4.14's "≥ 14 days
 * pre-scheduled" bar): a quiz sitting in a `daily_quiz` slot inside this window
 * is checked as if it were already official, because that is exactly the window
 * in which a takedown still has time to be noticed before play.
 */
const DAILY_LOOKAHEAD_DAYS = 14;

/**
 * Day-of-week (0 = Sunday) the *weekly* user-quiz pass runs on. §15 fixes three
 * cron schedules and task 4.2 puts a fourth out of scope (and `wrangler.jsonc`
 * off limits), so "weekly" is expressed as a gate inside the daily batch rather
 * than as its own trigger. Monday: a user quiz that died over the weekend is
 * flagged at the start of the week the owner is most likely to look.
 */
const USER_QUIZ_RECHECK_WEEKDAY = 1;

/** Which population a run covers — `'official'` nightly, `'user'` weekly (§5.3). */
export type AvailabilityScope = 'official' | 'user';

export interface AvailabilityDeps {
	db: Db;
	provider: CatalogProvider;
	now: number;
	/** Ranged-GET impl handed to `checkPreviewAvailability`; injected in tests so nothing hits the network (§17). */
	fetchImpl?: typeof fetch;
	/** Injected in tests; production passes nothing and the real Resend sender is used. */
	sendEmailImpl?: typeof sendEmail;
	/** Undefined in dev/CI — `sendEmail` then logs instead of sending (see `email.ts`). */
	resendApiKey?: string;
	batchSize?: number;
}

export interface UnavailableTrack {
	id: string;
	title: string;
}

export interface AvailabilityRunResult {
	/** Candidates actually probed this run. */
	checked: number;
	/** Tracks whose `unavailable_at` this run set (i.e. newly dead, not already-known). */
	newlyUnavailable: UnavailableTrack[];
	/** `daily_quiz.day` keys cleared because their quiz contains a dead track. */
	disqualifiedDays: string[];
	/** Operator addresses the incident email went to (empty when there was no incident). */
	alerted: string[];
}

// ---------------------------------------------------------------------------
// Verdict (pure)
// ---------------------------------------------------------------------------

export type AvailabilityVerdict = 'available' | 'gone' | 'inconclusive';

/**
 * Turns one probe into a decision. Pure, so the interesting half of this job is
 * unit-testable without a database or a network.
 *
 * `previewUrl === null` is a genuine takedown, not an error: `DeezerProvider`
 * answers an unresolvable id with `null` (Deezer returns HTTP 200 with an
 * `{ error }` body for a dead track — see `deezer.ts`'s header). By contrast
 * `status === 0` is `checkPreviewAvailability`'s "the fetch threw", and a 5xx
 * is the CDN having a bad day after the throttle already retried — neither is
 * evidence the clip is gone, and neither may cost a daily slot.
 */
export function verdictFor(
	previewUrl: string | null,
	check: PreviewCheckResult | null
): AvailabilityVerdict {
	if (previewUrl === null) return 'gone';
	if (check === null) return 'inconclusive';
	if (check.status === 0 || check.status >= 500) return 'inconclusive';
	return check.ok ? 'available' : 'gone';
}

/**
 * Weekly gate for the user-quiz pass (see `USER_QUIZ_RECHECK_WEEKDAY`).
 * Weekday is derived from the Europe/Paris calendar day, not from UTC, so the
 * pass lands on the same civil day the rest of the product is keyed to (§6).
 */
export function isUserQuizRecheckDay(now: number): boolean {
	const [year, month, day] = parisDay(now).split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === USER_QUIZ_RECHECK_WEEKDAY;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

interface Candidate {
	id: string;
	title: string;
}

/**
 * The next slice of tracks to probe for `scope`, oldest-`fetched_at` first (the
 * rotation cursor described in the module header).
 *
 * Tracks already carrying `unavailable_at` are excluded outright: this job only
 * ever moves a track from available to unavailable. Re-listing a known-dead
 * track would spend the batch budget re-confirming what is already recorded,
 * and "the clip came back" is an operator decision (clear the column, re-add
 * the track), not something a cron job should infer.
 */
async function selectCandidates(
	db: Db,
	scope: AvailabilityScope,
	now: number,
	limit: number
): Promise<Candidate[]> {
	const scopeCondition =
		scope === 'official'
			? // Official/daily quizzes, plus anything sitting in a daily slot inside
				// the admin lookahead — a still-`manual` quiz can be scheduled ahead
				// of publication, and that is precisely the case §5.3 wants caught
				// "ahead of publication".
				or(
					inArray(quiz.kind, ['official', 'daily']),
					exists(
						db
							.select({ one: sql`1` })
							.from(dailyQuiz)
							.where(
								and(
									eq(dailyQuiz.quizId, quiz.id),
									gte(dailyQuiz.day, parisDay(now)),
									lte(dailyQuiz.day, parisDayOffset(now, DAILY_LOOKAHEAD_DAYS))
								)
							)
					)
				)
			: inArray(quiz.kind, ['manual', 'generated']);

	const rows = await db
		.selectDistinct({
			id: trackCache.id,
			title: trackCache.title,
			fetchedAt: trackCache.fetchedAt
		})
		.from(trackCache)
		.innerJoin(quizTrack, eq(quizTrack.trackId, trackCache.id))
		.innerJoin(quiz, eq(quiz.id, quizTrack.quizId))
		.where(and(isNull(trackCache.unavailableAt), isNull(quiz.deletedAt), scopeCondition))
		.orderBy(asc(trackCache.fetchedAt))
		.limit(limit);

	return rows.map((row) => ({ id: row.id, title: row.title }));
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

async function probe(
	provider: CatalogProvider,
	trackId: string,
	fetchImpl: typeof fetch
): Promise<{ verdict: AvailabilityVerdict; durationMs: number | null }> {
	let previewUrl: string | null;
	try {
		previewUrl = await provider.getPreviewUrl(trackId);
	} catch {
		// A thrown provider call is a transport problem, not a takedown — the
		// `null` return is what means "gone" (see `verdictFor`).
		return { verdict: 'inconclusive', durationMs: null };
	}

	if (previewUrl === null) return { verdict: 'gone', durationMs: null };

	const check = await checkPreviewAvailability(previewUrl, fetchImpl);
	return { verdict: verdictFor(previewUrl, check), durationMs: check.durationMs };
}

// ---------------------------------------------------------------------------
// Disqualification (§5.3)
// ---------------------------------------------------------------------------

/**
 * Clears every **upcoming** (today or later, Europe/Paris) daily slot whose
 * quiz contains a track marked unavailable. Past slots are never touched: they
 * have already been played, and DAILY-5 keeps them playable as practice.
 *
 * `daily_quiz.quiz_id` is `NOT NULL`, so "clear the slot" is deleting the row —
 * which is exactly the representation `getDailyCalendar` already renders as
 * `quizId: null`, and exactly what makes `checkDailyPublicationGap` fire on its
 * own the next time the daily batch runs. `day_number` is not reassigned;
 * `scheduleDaily` derives the next number from the max, so a freed number is
 * simply retired rather than reused.
 */
export async function disqualifyUpcomingDailySlots(db: Db, now: number): Promise<string[]> {
	const doomed = await db
		.selectDistinct({ day: dailyQuiz.day })
		.from(dailyQuiz)
		.innerJoin(quizTrack, eq(quizTrack.quizId, dailyQuiz.quizId))
		.innerJoin(trackCache, eq(trackCache.id, quizTrack.trackId))
		.where(and(gte(dailyQuiz.day, parisDay(now)), isNotNull(trackCache.unavailableAt)))
		.orderBy(asc(dailyQuiz.day))
		.limit(AVAILABILITY_BATCH_SIZE);

	if (doomed.length === 0) return [];

	const days = doomed.map((row) => row.day);
	await db.delete(dailyQuiz).where(inArray(dailyQuiz.day, days));
	return days;
}

// ---------------------------------------------------------------------------
// Operator alert (§G-5: email via Resend + /admin banner)
// ---------------------------------------------------------------------------

export interface AvailabilityIncident {
	newlyUnavailable: UnavailableTrack[];
	disqualifiedDays: string[];
}

export function incidentIsEmpty(incident: AvailabilityIncident): boolean {
	return incident.newlyUnavailable.length === 0 && incident.disqualifiedDays.length === 0;
}

/** Short, factual, operator-facing — same register as `auth.ts`'s transactional mail. Not localized (operators only). */
export function renderIncidentEmail(incident: AvailabilityIncident): {
	subject: string;
	html: string;
} {
	const parts: string[] = [];
	if (incident.newlyUnavailable.length > 0) {
		const items = incident.newlyUnavailable.map((t) => `<li>${t.title} (${t.id})</li>`).join('');
		parts.push(
			`<p>${incident.newlyUnavailable.length} track(s) newly marked unavailable:</p><ul>${items}</ul>`
		);
	}
	if (incident.disqualifiedDays.length > 0) {
		parts.push(
			`<p>Daily slot(s) cleared because their quiz contains an unavailable track: ${incident.disqualifiedDays.join(', ')}. Reschedule them from /admin.</p>`
		);
	}
	return {
		subject: 'Devinyl: availability re-check found a takedown',
		html: parts.join('')
	};
}

/**
 * One email per operator per incident batch — the batch, not the track, is the
 * unit, so a night that kills five clips is one email, not five.
 *
 * The `/admin` banner half of the alert is not sent from here: it is *derived*
 * from `track_cache.unavailable_at` and the empty upcoming slots this run just
 * created (`admin/index.ts`'s `listAvailabilityIncidents`), which is what keeps
 * task 4.2 free of a schema migration.
 */
export async function alertOperators(
	db: Db,
	incident: AvailabilityIncident,
	deps: Pick<AvailabilityDeps, 'sendEmailImpl' | 'resendApiKey'>
): Promise<string[]> {
	if (incidentIsEmpty(incident)) return [];

	console.error(
		`[availability] takedown alert: ${incident.newlyUnavailable.length} track(s) unavailable, ${incident.disqualifiedDays.length} daily slot(s) cleared`
	);

	const operators = await db
		.select({ email: user.email })
		.from(user)
		.where(and(eq(user.isOperator, true), isNull(user.deletedEmailHashExpiresAt)));
	if (operators.length === 0) return [];

	const send = deps.sendEmailImpl ?? sendEmail;
	const { subject, html } = renderIncidentEmail(incident);
	for (const operator of operators) {
		await send(deps.resendApiKey, { to: operator.email, subject, html });
	}
	return operators.map((o) => o.email);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * One bounded re-check pass. `scope: 'official'` is the nightly §5.3 pass;
 * `scope: 'user'` is the weekly one, gated by `isUserQuizRecheckDay` at the
 * call site.
 *
 * Slot disqualification runs on every pass, not only the official one: a track
 * can sit in both a user quiz and a scheduled daily, and the cost of a stale
 * daily slot (MUS-5 voiding every session that hits it) is high enough that the
 * cheap re-scan is worth doing whenever anything was marked.
 */
export async function runAvailabilityRecheck(
	deps: AvailabilityDeps & { scope: AvailabilityScope }
): Promise<AvailabilityRunResult> {
	const { db, provider, now, scope } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const batchSize = deps.batchSize ?? AVAILABILITY_BATCH_SIZE;

	const candidates = await selectCandidates(db, scope, now, batchSize);
	const newlyUnavailable: UnavailableTrack[] = [];

	for (const candidate of candidates) {
		const { verdict, durationMs } = await probe(provider, candidate.id, fetchImpl);

		if (verdict === 'inconclusive') continue;

		if (verdict === 'available') {
			// Restamping `fetched_at` is what rotates the cursor; `preview_ms` is
			// refreshed for free from the same ranged GET (§7.3 checks a client's
			// `clipMs` against it).
			await db
				.update(trackCache)
				.set(durationMs === null ? { fetchedAt: now } : { fetchedAt: now, previewMs: durationMs })
				.where(eq(trackCache.id, candidate.id));
			continue;
		}

		// `isNull(unavailableAt)` in the WHERE, not just in the candidate query:
		// the first observation must survive a concurrent run that got there first.
		await db
			.update(trackCache)
			.set({ unavailableAt: now })
			.where(and(eq(trackCache.id, candidate.id), isNull(trackCache.unavailableAt)));
		newlyUnavailable.push(candidate);
	}

	// Unconditional, not gated on `newlyUnavailable`: a track can be marked dead
	// by the *other* scope's pass (or by a run that crashed before it got here)
	// and only later be scheduled into a daily slot. The scan is one indexed
	// join, and it is self-limiting — a cleared slot is gone, so a steady state
	// finds nothing and alerts nothing.
	const disqualifiedDays = await disqualifyUpcomingDailySlots(db, now);

	const incident: AvailabilityIncident = { newlyUnavailable, disqualifiedDays };
	const alerted = await alertOperators(db, incident, deps);

	return { checked: candidates.length, newlyUnavailable, disqualifiedDays, alerted };
}
