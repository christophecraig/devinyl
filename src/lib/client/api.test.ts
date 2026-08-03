/**
 * Unit tests for `src/lib/client/api.ts` (plan task 1.26).
 *
 * `./guest.js` is owned by a concurrently-written module and mocked here so
 * these tests don't depend on its existence or implementation — only on the
 * documented contract: `guestHeaders(): Record<string, string>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./guest.js', () => ({
	guestHeaders: () => ({ 'x-guest-id': 'guest-under-test' })
}));

import {
	ApiError,
	createSession,
	finalizeSession,
	generateQuiz,
	isRetryable,
	postRoundResult,
	postRoundStart
} from './api.js';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('api.ts', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('generateQuiz posts filters and returns the quizId', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ quizId: 'q1' }, 201));

		const result = await generateQuiz({ decade: 1980, rounds: 10 });

		expect(result).toEqual({ quizId: 'q1' });
		const [path, init] = fetchMock.mock.calls[0];
		expect(path).toBe('/api/quizzes/generate');
		expect(init.method).toBe('POST');
		expect(init.headers['x-guest-id']).toBe('guest-under-test');
		expect(init.headers['content-type']).toBe('application/json');
		expect(JSON.parse(init.body)).toEqual({ decade: 1980, rounds: 10 });
	});

	it('createSession posts the body and returns the manifest', async () => {
		const manifest = { sessionId: 's1', quizId: 'q1', rounds: [] };
		fetchMock.mockResolvedValue(jsonResponse(manifest, 201));

		const result = await createSession({ quizId: 'q1', nickname: 'Ada' });

		expect(result).toEqual(manifest);
	});

	it('postRoundStart hits the positional route and resolves on 204', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

		await expect(postRoundStart('s1', 3)).resolves.toBeUndefined();
		expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s1/rounds/3/start');
	});

	it('postRoundResult hits the route derived from body.position and resolves on 204', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

		await postRoundResult('s1', {
			position: 2,
			guessLog: [],
			lockTimes: {},
			clipMs: 30000,
			skipped: false
		});

		expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s1/rounds/2/result');
	});

	it('finalizeSession posts and returns the FinalizeResult', async () => {
		const finalizeResult = {
			sessionId: 's1',
			totalScore: 1000,
			rounds: [],
			scored: true,
			scoredBlockReason: null,
			effectiveScoringMode: 'speed',
			curveVersion: 1,
			finalizedAt: 123
		};
		fetchMock.mockResolvedValue(jsonResponse(finalizeResult));

		const result = await finalizeSession('s1', {});

		expect(result).toEqual(finalizeResult);
	});

	it('throws ApiError with the server code/message on a non-2xx JSON error envelope', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ code: 'conflict', message: 'Already scored.' }, 409)
		);

		await expect(createSession({ quizId: 'q1', nickname: 'Ada' })).rejects.toMatchObject({
			name: 'ApiError',
			status: 409,
			code: 'conflict',
			message: 'Already scored.'
		});
	});

	it('falls back to a generic ApiError when the error body is not JSON', async () => {
		fetchMock.mockResolvedValue(new Response('<html>gateway error</html>', { status: 502 }));

		await expect(createSession({ quizId: 'q1', nickname: 'Ada' })).rejects.toMatchObject({
			status: 502,
			code: 'internal'
		});
	});

	it('wraps a rejected fetch as a retryable network_error ApiError', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

		const err = await createSession({ quizId: 'q1', nickname: 'Ada' }).catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		expect(err.code).toBe('network_error');
		expect(isRetryable(err)).toBe(true);
	});

	describe('isRetryable', () => {
		it('is true for network errors', () => {
			expect(isRetryable(new ApiError(0, 'network_error', 'x'))).toBe(true);
		});

		it('is true for 429', () => {
			expect(isRetryable(new ApiError(429, 'rate_limited', 'x'))).toBe(true);
		});

		it('is true for 5xx', () => {
			expect(isRetryable(new ApiError(503, 'unavailable', 'x'))).toBe(true);
			expect(isRetryable(new ApiError(500, 'internal', 'x'))).toBe(true);
		});

		it('is false for other 4xx', () => {
			expect(isRetryable(new ApiError(400, 'bad_request', 'x'))).toBe(false);
			expect(isRetryable(new ApiError(403, 'forbidden', 'x'))).toBe(false);
			expect(isRetryable(new ApiError(404, 'not_found', 'x'))).toBe(false);
			expect(isRetryable(new ApiError(409, 'conflict', 'x'))).toBe(false);
			expect(isRetryable(new ApiError(410, 'gone', 'x'))).toBe(false);
		});

		it('treats a non-ApiError as retryable (unknown failure mode)', () => {
			expect(isRetryable(new Error('boom'))).toBe(true);
		});
	});
});
