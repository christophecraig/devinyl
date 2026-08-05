/**
 * Calendar helpers — technical-spec §6, §11.
 *
 * The product's day boundary is **Europe/Paris**, not UTC: the daily quiz
 * (DAILY-1), streaks (DAILY-4), and the weekly ladder (STAT-4) are all keyed to
 * the audience's local midnight, and the audience is French. Getting this wrong
 * doesn't fail loudly — it just silently rolls the daily over at 1 or 2 a.m.
 * for everyone, twice a year, when the DST offset shifts.
 *
 * Hence `Intl.DateTimeFormat` with an explicit `timeZone` rather than any
 * arithmetic on UTC offsets: it is the only thing in the platform that knows
 * when France changes clocks, and it is available in the Workers runtime.
 */

const PARIS = 'Europe/Paris';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: PARIS,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/** The `YYYY-MM-DD` Europe/Paris calendar day — the `daily_quiz.day` key (§6). */
export function parisDay(now: number = Date.now()): string {
	// 'en-CA' formats as YYYY-MM-DD, which is the key format §6 specifies.
	return dayFormatter.format(new Date(now));
}

/**
 * The Paris calendar day `offsetDays` after `now` (negative goes backward) —
 * the daily-calendar gap-warning scan (task 2.9, CREATE-9) walks this
 * forward from today. Arithmetic on the formatted `YYYY-MM-DD` string's UTC
 * midnight is exact for calendar-day stepping even though it ignores Paris's
 * own DST shifts, because a day boundary is still a day boundary either side
 * of one.
 */
export function parisDayOffset(now: number, offsetDays: number): string {
	return shiftParisDay(parisDay(now), offsetDays);
}

/**
 * Calendar-day arithmetic on an already-formatted `YYYY-MM-DD` day key, with
 * no `now` involved — the streak run-length walk (task 3.4) needs to step
 * backward from an arbitrary stored day, not from "now". Same exactness
 * argument as `parisDayOffset`: a day boundary is a day boundary regardless
 * of Paris's own DST shifts.
 */
export function shiftParisDay(day: string, offsetDays: number): string {
	const [year, month, date] = day.split('-').map(Number);
	const d = new Date(Date.UTC(year, month - 1, date));
	d.setUTCDate(d.getUTCDate() + offsetDays);
	return d.toISOString().slice(0, 10);
}

/**
 * The Unix-ms instant Europe/Paris midnight begins for `day` — the metrics
 * aggregation job (task 3.11) needs a `[start, end)` ms range to bucket
 * `game_session.started_at` by Paris calendar day, and there's no cheap
 * closed-form inverse of `Intl.DateTimeFormat` for that. Binary search
 * instead: `parisDay(ms)` is monotonic in `ms`, so bisecting a window known
 * to straddle the boundary finds it exactly, DST included.
 */
export function parisDayStartMs(day: string): number {
	const guess = Date.parse(`${day}T00:00:00.000Z`);
	// Paris is UTC+1 (winter) or UTC+2 (summer), so the real boundary sits
	// within a couple of hours of the UTC guess either side — 6h of slack on
	// each end guarantees `lo` lands the day before and `hi` lands on `day`.
	let lo = guess - 6 * 60 * 60 * 1000;
	let hi = guess + 6 * 60 * 60 * 1000;
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (parisDay(mid) < day) lo = mid;
		else hi = mid;
	}
	return hi;
}

/** `[start, end)` ms range covering every instant that falls on `day` in Europe/Paris. */
export function parisDayRangeMs(day: string): { startMs: number; endMs: number } {
	return { startMs: parisDayStartMs(day), endMs: parisDayStartMs(shiftParisDay(day, 1)) };
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: PARIS,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false
});

/** The wall-clock date in Paris, as a `Date` in UTC terms — the input to ISO-week arithmetic. */
function parisCivilDate(now: number): Date {
	const parts = Object.fromEntries(
		partsFormatter.formatToParts(new Date(now)).map((p) => [p.type, p.value])
	);
	return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

/**
 * ISO-8601 week key (`2026-W32`) in Europe/Paris — the `weekly_points.week`
 * primary-key component (§6, §11). ISO weeks start Monday and belong to the
 * year containing their Thursday, which is why the year here is computed from
 * the shifted date rather than taken from the input.
 */
export function parisIsoWeek(now: number = Date.now()): string {
	const date = parisCivilDate(now);

	// Shift to the Thursday of this week; its calendar year is the ISO year.
	const dayOfWeek = (date.getUTCDay() + 6) % 7; // Monday = 0
	date.setUTCDate(date.getUTCDate() - dayOfWeek + 3);

	const isoYear = date.getUTCFullYear();
	const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
	const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);

	const week =
		1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
	return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
