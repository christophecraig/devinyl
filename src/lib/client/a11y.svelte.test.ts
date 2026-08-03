/**
 * Unit tests for the announcement queue (src/lib/client/a11y.svelte.ts).
 *
 * Queue logic only, no DOM — `LiveRegion.svelte` (which mounts the actual
 * live regions) is exercised separately by the E2E live-region-ordering
 * checks (plan task 1.30, §17), not here.
 */
import { describe, expect, it } from 'vitest';
import { createAnnouncer } from './a11y.svelte.js';

describe('createAnnouncer', () => {
	it('holds a deferred announcement during a clip and flushes it at clip end', () => {
		const announcer = createAnnouncer();

		announcer.clipStarted();
		announcer.announce({ text: 'Reveal: Track A', politeness: 'polite', deferUntilGap: true });

		// Held — must not speak over the clip (A11Y-3).
		expect(announcer.polite).toBe('');

		announcer.clipEnded();

		expect(announcer.polite.startsWith('Reveal: Track A')).toBe(true);
	});

	it('preserves order when several deferred items flush at once', () => {
		const announcer = createAnnouncer();

		announcer.clipStarted();
		announcer.announce({ text: 'First', politeness: 'polite', deferUntilGap: true });
		announcer.announce({ text: 'Second', politeness: 'polite', deferUntilGap: true });
		announcer.clipEnded();

		// If the queue processed out of order (e.g. LIFO), "First" would win
		// and be the visible value instead.
		expect(announcer.polite.startsWith('Second')).toBe(true);
	});

	it('produces a distinct value for repeated identical text', () => {
		const announcer = createAnnouncer();

		announcer.announce({ text: 'Incorrect', politeness: 'assertive' });
		const first = announcer.assertive;

		announcer.announce({ text: 'Incorrect', politeness: 'assertive' });
		const second = announcer.assertive;

		// A screen reader treats an unchanged live-region text as a no-op;
		// the nonce must make consecutive identical announcements differ.
		expect(second).not.toBe(first);
		expect(first.startsWith('Incorrect')).toBe(true);
		expect(second.startsWith('Incorrect')).toBe(true);

		announcer.announce({ text: 'Incorrect', politeness: 'assertive' });
		const third = announcer.assertive;

		// And not just alternating back to the exact first value either —
		// each successive emission must differ from its immediate predecessor.
		expect(third).not.toBe(second);
	});

	it('clears both regions and the deferred queue', () => {
		const announcer = createAnnouncer();

		announcer.announce({ text: 'Score: 10', politeness: 'polite' });
		announcer.announce({ text: 'Correct', politeness: 'assertive' });
		announcer.clipStarted();
		announcer.announce({ text: 'Reveal: X', politeness: 'polite', deferUntilGap: true });

		announcer.clear();

		expect(announcer.assertive).toBe('');
		expect(announcer.polite).toBe('');

		// The deferred item queued before clear() must not resurface later.
		announcer.clipEnded();
		expect(announcer.polite).toBe('');
	});

	it('speaks non-deferred assertive announcements immediately, even mid-clip', () => {
		const announcer = createAnnouncer();

		announcer.clipStarted();
		announcer.announce({ text: 'Correct', politeness: 'assertive' });

		// Accept/reject is assertive and not deferred (ROUND-2/A11Y-2) — it
		// must go out right away rather than waiting for clipEnded().
		expect(announcer.assertive.startsWith('Correct')).toBe(true);

		announcer.clipEnded();

		// clipEnded() must not touch a region that had nothing deferred.
		expect(announcer.assertive.startsWith('Correct')).toBe(true);
	});
});
