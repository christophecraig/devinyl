import { describe, expect, it } from 'vitest';
import { parisDay, parisDayOffset } from './time.js';

describe('parisDayOffset', () => {
	it('steps forward N days from the given instant', () => {
		const now = Date.parse('2026-08-05T10:00:00Z');
		expect(parisDayOffset(now, 0)).toBe(parisDay(now));
		expect(parisDayOffset(now, 1)).toBe('2026-08-06');
		expect(parisDayOffset(now, 7)).toBe('2026-08-12');
	});

	it('steps backward for a negative offset', () => {
		const now = Date.parse('2026-08-05T10:00:00Z');
		expect(parisDayOffset(now, -1)).toBe('2026-08-04');
	});

	it('crosses a month boundary', () => {
		const now = Date.parse('2026-08-31T10:00:00Z');
		expect(parisDayOffset(now, 1)).toBe('2026-09-01');
	});
});
