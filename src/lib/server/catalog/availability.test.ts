import { describe, expect, it } from 'vitest';
import {
	checkPreviewAvailability,
	durationMsFromByteCount,
	MAX_PLAUSIBLE_PREVIEW_MS,
	MIN_PLAUSIBLE_PREVIEW_MS,
	totalBytesFromContentRange
} from './availability.js';

describe('totalBytesFromContentRange', () => {
	it('parses a real Deezer content-range header (captured live, §5.5 probe: 479827 B ≈ 30.0 s)', () => {
		expect(totalBytesFromContentRange('bytes 0-1/479827')).toBe(479827);
	});

	it('returns null for a missing or malformed header', () => {
		expect(totalBytesFromContentRange(null)).toBeNull();
		expect(totalBytesFromContentRange('')).toBeNull();
		expect(totalBytesFromContentRange('not-a-content-range')).toBeNull();
		expect(totalBytesFromContentRange('bytes 0-1/0')).toBeNull();
	});
});

describe('durationMsFromByteCount — 128 kbps CBR', () => {
	it('matches the probe-measured 30.0 s clip within rounding', () => {
		expect(durationMsFromByteCount(479827)).toBe(29989);
	});

	it('is linear in byte count', () => {
		expect(durationMsFromByteCount(160000)).toBe(10000);
	});
});

function fakeFetch(status: number, contentRange: string | null): typeof fetch {
	return (async () =>
		new Response(new Uint8Array([0, 1]), {
			status,
			headers: contentRange ? { 'content-range': contentRange } : {}
		})) as typeof fetch;
}

describe('checkPreviewAvailability — MUS-5 add-time enforcement', () => {
	it('accepts a 206 ranged response with a plausible duration', async () => {
		const result = await checkPreviewAvailability(
			'https://example.test/preview.mp3',
			fakeFetch(206, 'bytes 0-1/479827')
		);
		expect(result).toEqual({ ok: true, status: 206, durationMs: 29989 });
	});

	it('accepts a plain 200 too', async () => {
		const result = await checkPreviewAvailability(
			'https://example.test/preview.mp3',
			fakeFetch(200, 'bytes 0-1/479827')
		);
		expect(result.ok).toBe(true);
	});

	it('refuses a 404', async () => {
		const result = await checkPreviewAvailability(
			'https://example.test/gone.mp3',
			fakeFetch(404, null)
		);
		expect(result).toEqual({ ok: false, status: 404, durationMs: null });
	});

	it('refuses a 200 with no usable content-range (cannot verify duration)', async () => {
		const result = await checkPreviewAvailability(
			'https://example.test/no-range.mp3',
			fakeFetch(200, null)
		);
		expect(result).toEqual({ ok: false, status: 200, durationMs: null });
	});

	it('refuses an implausibly short duration even on a 206', async () => {
		const result = await checkPreviewAvailability(
			'https://example.test/tiny.mp3',
			fakeFetch(206, 'bytes 0-1/800')
		);
		expect(result.ok).toBe(false);
		expect(result.durationMs).toBeLessThan(MIN_PLAUSIBLE_PREVIEW_MS);
	});

	it('refuses an implausibly long duration', async () => {
		const hugeBytes = 20_000_000; // ~1000s at 128kbps — nowhere near a 30s preview
		const result = await checkPreviewAvailability(
			'https://example.test/huge.mp3',
			fakeFetch(206, `bytes 0-1/${hugeBytes}`)
		);
		expect(result.ok).toBe(false);
		expect(result.durationMs).toBeGreaterThan(MAX_PLAUSIBLE_PREVIEW_MS);
	});

	it('never persists the response body — only reads headers/length', async () => {
		// Regression guard for the ADR-0001 "no audio storage" obligation: this
		// function must never return the bytes it read, only derived numbers.
		const result = await checkPreviewAvailability(
			'https://example.test/preview.mp3',
			fakeFetch(206, 'bytes 0-1/479827')
		);
		expect(Object.keys(result)).toEqual(['ok', 'status', 'durationMs']);
	});

	it('handles a network failure gracefully', async () => {
		const throwingFetch = (async () => {
			throw new Error('network down');
		}) as typeof fetch;
		const result = await checkPreviewAvailability(
			'https://example.test/preview.mp3',
			throwingFetch
		);
		expect(result).toEqual({ ok: false, status: 0, durationMs: null });
	});
});
