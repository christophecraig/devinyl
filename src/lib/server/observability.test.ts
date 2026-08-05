import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from './observability.js';

/**
 * SENTRY_DSN is [USER] (plan 4.8) and unset in every environment these tests
 * run in, so the coverage that matters here is the no-op path: captureError()
 * must never throw and must never attempt a network call without a DSN.
 * `sendToSentry`'s envelope-building/fetch path only runs once a real DSN
 * exists, which isn't available to CI — see docs/runbooks/logs.md for how to
 * verify it manually once SENTRY_DSN is set.
 */
describe('captureError', () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		fetchSpy.mockRestore();
	});

	it('logs to console and never throws when dsn is undefined', () => {
		expect(() =>
			captureError(undefined, new Error('boom'), { source: 'test' })
		).not.toThrow();
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it('does not call fetch when dsn is undefined', () => {
		captureError(undefined, new Error('boom'), { source: 'test' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('does not call fetch when dsn is an empty string', () => {
		captureError('', new Error('boom'), { source: 'test' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('forwards to the Sentry envelope endpoint when dsn is set', () => {
		captureError('https://publickey@o123.ingest.sentry.io/456', new Error('boom'), {
			source: 'test'
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://o123.ingest.sentry.io/api/456/envelope/',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('degrades to a console.error, never throwing, when dsn is malformed', () => {
		expect(() => captureError('not-a-valid-dsn', new Error('boom'), { source: 'test' })).not.toThrow();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
