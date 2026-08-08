/**
 * Pure decision logic for the §5.3 availability re-check (task 4.2). The
 * database-touching half lives in `availability.integration.test.ts` — same
 * split as `index.test.ts` vs `sweep.integration.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	alertOperators,
	incidentIsEmpty,
	isUserQuizRecheckDay,
	renderIncidentEmail,
	verdictFor
} from './availability.js';

describe('verdictFor', () => {
	it('treats a null preview URL as a takedown', () => {
		// DeezerProvider returns null for an id the provider no longer resolves
		// (Deezer answers those with HTTP 200 + an `{ error }` body).
		expect(verdictFor(null, null)).toBe('gone');
	});

	it('treats a transport failure as inconclusive, not a takedown', () => {
		expect(verdictFor('https://cdn.test/p.mp3', { ok: false, status: 0, durationMs: null })).toBe(
			'inconclusive'
		);
	});

	it('treats a 5xx as inconclusive', () => {
		expect(verdictFor('https://cdn.test/p.mp3', { ok: false, status: 503, durationMs: null })).toBe(
			'inconclusive'
		);
	});

	it('treats a 404 as a takedown', () => {
		expect(verdictFor('https://cdn.test/p.mp3', { ok: false, status: 404, durationMs: null })).toBe(
			'gone'
		);
	});

	it('treats a 200 with an implausible duration as a takedown', () => {
		// checkPreviewAvailability already folds "duration out of bounds" into
		// ok: false; this asserts the job does not second-guess it back to alive.
		expect(verdictFor('https://cdn.test/p.mp3', { ok: false, status: 206, durationMs: 40 })).toBe(
			'gone'
		);
	});

	it('treats a healthy ranged GET as available', () => {
		expect(
			verdictFor('https://cdn.test/p.mp3', { ok: true, status: 206, durationMs: 29_989 })
		).toBe('available');
	});
});

describe('isUserQuizRecheckDay (weekly gate inside the daily batch)', () => {
	it('is true exactly once across any seven consecutive Paris days', () => {
		// Midday UTC keeps every step inside the same Paris civil day regardless
		// of the +1/+2 offset.
		const start = Date.parse('2026-08-03T12:00:00Z');
		const flags = Array.from({ length: 7 }, (_, i) =>
			isUserQuizRecheckDay(start + i * 24 * 60 * 60 * 1000)
		);
		expect(flags.filter(Boolean)).toHaveLength(1);
	});

	it('lands on Monday', () => {
		expect(isUserQuizRecheckDay(Date.parse('2026-08-03T12:00:00Z'))).toBe(true); // Monday
		expect(isUserQuizRecheckDay(Date.parse('2026-08-04T12:00:00Z'))).toBe(false); // Tuesday
	});
});

describe('incidentIsEmpty / renderIncidentEmail', () => {
	it('is empty only when nothing was marked and nothing was cleared', () => {
		expect(incidentIsEmpty({ newlyUnavailable: [], disqualifiedDays: [] })).toBe(true);
		expect(
			incidentIsEmpty({ newlyUnavailable: [{ id: 'deezer:1', title: 'T' }], disqualifiedDays: [] })
		).toBe(false);
		expect(incidentIsEmpty({ newlyUnavailable: [], disqualifiedDays: ['2026-08-09'] })).toBe(false);
	});

	it('names both the dead tracks and the cleared days', () => {
		const { subject, html } = renderIncidentEmail({
			newlyUnavailable: [{ id: 'deezer:3135553', title: 'One More Time' }],
			disqualifiedDays: ['2026-08-09']
		});
		expect(subject).toContain('availability');
		expect(html).toContain('One More Time');
		expect(html).toContain('deezer:3135553');
		expect(html).toContain('2026-08-09');
	});
});

/** Same hand-rolled chainable stand-in `index.test.ts` uses — see its comment. */
function fakeDbReturning(rows: unknown[]) {
	const builder: Record<string, unknown> = {};
	Object.assign(builder, {
		from: () => builder,
		where: () => builder,
		limit: () => builder,
		then: (onFulfilled?: (value: unknown) => unknown) => Promise.resolve(rows).then(onFulfilled)
	});
	return { select: vi.fn(() => builder) } as unknown as Parameters<typeof alertOperators>[0];
}

describe('alertOperators', () => {
	it('sends nothing at all for an empty incident', async () => {
		const send = vi.fn();
		const db = fakeDbReturning([{ email: 'op@example.test' }]);

		const alerted = await alertOperators(
			db,
			{ newlyUnavailable: [], disqualifiedDays: [] },
			{ sendEmailImpl: send }
		);

		expect(alerted).toEqual([]);
		expect(send).not.toHaveBeenCalled();
		// The operator list isn't even queried — an empty incident is decided first.
		expect(vi.mocked((db as unknown as { select: () => unknown }).select)).not.toHaveBeenCalled();
	});

	it('sends one email per operator, once per incident batch', async () => {
		const send = vi.fn();
		const db = fakeDbReturning([{ email: 'a@example.test' }, { email: 'b@example.test' }]);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const alerted = await alertOperators(
			db,
			{
				newlyUnavailable: [
					{ id: 'deezer:1', title: 'A' },
					{ id: 'deezer:2', title: 'B' }
				],
				disqualifiedDays: ['2026-08-09']
			},
			{ sendEmailImpl: send, resendApiKey: undefined }
		);

		// Two dead tracks + one cleared slot is still *one* email each, not three.
		expect(send).toHaveBeenCalledTimes(2);
		expect(alerted).toEqual(['a@example.test', 'b@example.test']);
		errorSpy.mockRestore();
	});

	it('sends nothing when there are no operators to tell', async () => {
		const send = vi.fn();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const alerted = await alertOperators(
			fakeDbReturning([]),
			{ newlyUnavailable: [{ id: 'deezer:1', title: 'A' }], disqualifiedDays: [] },
			{ sendEmailImpl: send }
		);

		expect(alerted).toEqual([]);
		expect(send).not.toHaveBeenCalled();
		// It still logs loudly — `wrangler tail` is the fallback channel (§G-17).
		expect(errorSpy).toHaveBeenCalledTimes(1);
		errorSpy.mockRestore();
	});
});
