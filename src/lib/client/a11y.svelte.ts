/**
 * Announcement queue for the play flow — technical-spec A11Y-2/3/6, plan task 1.27.
 *
 * This is an *audio* game: a screen reader talking over the clip is not an
 * accessibility win, it destroys the thing being tested (ROUND-2, no
 * pause/replay). So announcements can't just fire the instant state
 * changes — they have to be schedulable to the gaps between clips. That's
 * the whole point of this module: `Announcer` is a tiny two-lane queue
 * (`assertive`/`polite`, mirroring the two live regions in
 * `LiveRegion.svelte`) where an announcement can ask to be `deferUntilGap`
 * and get held until `clipEnded()` instead of speaking immediately.
 *
 * Per the spec split: `assertive` carries countdown ticks, clip start/end,
 * and answer accept/reject (interrupts, but never during the clip itself —
 * that's the caller's job, not this queue's, since none of those fire
 * mid-clip in the state machine). `polite` carries the reveal and
 * scoreboard, and reveal specifically is `deferUntilGap: true` — it is
 * announced when the clip ends, not when the reveal state is entered,
 * because those two moments are the same wall-clock instant only when a
 * round runs to its natural end (§7.4); on an early end (ROUND-3, all
 * targets locked) they're not, and speaking the reveal early would still be
 * talking over whatever's left of the clip.
 *
 * File is `.svelte.ts` (not `.ts`) because `assertive`/`polite` need to be
 * `$state` — `LiveRegion.svelte` binds directly to the getters and must
 * re-render when they change, which plain object mutation can't do outside
 * Svelte's compiled reactivity.
 *
 * ## The identical-text problem
 *
 * Most screen readers only re-announce a live region when its *text
 * content* changes; assigning the same string to it twice is a no-op,
 * because nothing in the DOM actually mutated. That would silently eat
 * every other "Incorrect" in a run of repeated wrong guesses, or a
 * countdown that happens to repeat a number after a re-render. The usual
 * workaround (and the one used here) is a nonce appended to the text so
 * consecutive values are never literally equal: each emission toggles a
 * trailing zero-width space (U+200B, invisible, does not affect the
 * rendered/spoken text) on or off. It looks like nonsense in isolation —
 * "why would you conditionally append an invisible character" — but
 * without it, two same-text announcements in a row are indistinguishable
 * to the DOM and the second is silently dropped by most AT.
 */

const ZERO_WIDTH_SPACE = '​';

export type Politeness = 'assertive' | 'polite';

export interface Announcement {
	text: string;
	politeness: Politeness;
	/** Hold until the clip ends. */
	deferUntilGap?: boolean;
}

export interface Announcer {
	readonly assertive: string;
	readonly polite: string;
	announce(a: Announcement): void;
	/** Clip started — deferred announcements now wait. */
	clipStarted(): void;
	/** Clip ended — flush anything held. */
	clipEnded(): void;
	clear(): void;
}

class AnnouncerImpl implements Announcer {
	private assertiveState = $state('');
	private politeState = $state('');

	/** Per-region toggle behind the zero-width-space nonce described above. */
	private assertiveToggle = false;
	private politeToggle = false;

	private clipActive = false;

	/**
	 * FIFO — a plain array is enough since `clipEnded()` drains it
	 * synchronously in one pass; nothing needs to observe it mid-drain.
	 */
	private deferred: Announcement[] = [];

	get assertive(): string {
		return this.assertiveState;
	}

	get polite(): string {
		return this.politeState;
	}

	announce(a: Announcement): void {
		if (a.deferUntilGap && this.clipActive) {
			this.deferred.push(a);
			return;
		}
		this.emit(a);
	}

	clipStarted(): void {
		this.clipActive = true;
	}

	clipEnded(): void {
		this.clipActive = false;
		// Snapshot-then-clear before iterating: `emit` never re-enters
		// `announce`, but doing it this way means a stray re-entrant push
		// during the drain lands in the *next* flush instead of extending
		// this one indefinitely.
		const queued = this.deferred;
		this.deferred = [];
		for (const a of queued) this.emit(a);
	}

	clear(): void {
		this.assertiveState = '';
		this.politeState = '';
		this.assertiveToggle = false;
		this.politeToggle = false;
		this.deferred = [];
	}

	private emit(a: Announcement): void {
		if (a.politeness === 'assertive') {
			this.assertiveToggle = !this.assertiveToggle;
			this.assertiveState = this.assertiveToggle ? a.text + ZERO_WIDTH_SPACE : a.text;
		} else {
			this.politeToggle = !this.politeToggle;
			this.politeState = this.politeToggle ? a.text + ZERO_WIDTH_SPACE : a.text;
		}
	}
}

export function createAnnouncer(): Announcer {
	return new AnnouncerImpl();
}

/**
 * Focus helper for the "deliberate focus move at every transition" half of
 * A11Y-3 — phase changes (countdown → clip, clip → reveal, reveal →
 * scoreboard, ...) must move focus somewhere sensible rather than leaving
 * it on a control that just disappeared or letting it silently reset to
 * `<body>`. Focuses the first focusable descendant of `container`, or
 * `container` itself if nothing inside qualifies (the common pattern for a
 * transition heading: `<h2 tabindex="-1">Round 3</h2>` as the container).
 *
 * Deliberately does not throw or special-case "not actually focusable" —
 * calling `.focus()` on an element that can't take focus is a documented
 * no-op, which is the right fallback behaviour here without extra branches.
 */
const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])'
].join(', ');

export function focusFirst(container: HTMLElement | null): void {
	if (!container) return;
	const target = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? container;
	target.focus();
}
