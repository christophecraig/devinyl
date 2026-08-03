/**
 * Typed fetch wrappers for every player-facing API route — technical-spec §7,
 * §10, plan task 1.26.
 *
 * One function per endpoint, all thin: attach identity + content-type,
 * send/parse JSON, and turn the server's error envelope (`{ code, message }`,
 * see `src/lib/server/http.ts`) into a thrown `ApiError` so callers get a
 * single catch shape instead of re-deriving status/code handling at every
 * call site. `queue.ts` builds the offline layer on top of these.
 */

import type {
	CreateSessionBody,
	FinalizeSessionBody,
	GenerationFiltersBody,
	RoundResultBody
} from '$lib/game/schemas.js';
import type { FinalizeResult, SessionManifest } from '$lib/game/types.js';
import { guestHeaders } from './guest.js';

/** Mirrors `ApiErrorCode` in `src/lib/server/http.ts` — kept as a literal union rather than imported so this module never pulls in server-only code. */
export type ApiErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'gone'
	| 'conflict'
	| 'rate_limited'
	| 'unavailable'
	| 'internal'
	/** The response body wasn't the `{ code, message }` envelope at all — a transport-level failure, not a modeled API error. */
	| 'network_error';

export class ApiError extends Error {
	readonly status: number;
	readonly code: ApiErrorCode;
	readonly extra?: unknown;

	constructor(status: number, code: ApiErrorCode, message: string, extra?: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.extra = extra;
	}
}

/**
 * Retryable = worth queuing/backing off on (transport failure, 429, 5xx).
 * Any other 4xx is a client mistake or a rule that will never pass on retry
 * (403/404/409/410/400) — retrying those forever is the bug §4 explicitly
 * calls out for pending-finalize handling.
 */
export function isRetryable(err: unknown): boolean {
	if (!(err instanceof ApiError)) return true; // unknown/thrown-before-parse failures are treated as transport issues
	if (err.code === 'network_error') return true;
	if (err.status === 429) return true;
	if (err.status >= 500) return true;
	return false;
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: {
				'content-type': 'application/json',
				...guestHeaders(),
				...init.headers
			}
		});
	} catch (cause) {
		throw new ApiError(0, 'network_error', 'Network request failed.', cause);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	if (!response.ok) {
		let code: ApiErrorCode = 'internal';
		let message = `Request failed with status ${response.status}.`;
		try {
			const body = (await response.json()) as { code?: string; message?: string };
			if (body.code) code = body.code as ApiErrorCode;
			if (body.message) message = body.message;
		} catch {
			// Body wasn't JSON (e.g. a platform-level error page) — fall back to the generic message above.
		}
		throw new ApiError(response.status, code, message);
	}

	return (await response.json()) as T;
}

export async function generateQuiz(filters: GenerationFiltersBody): Promise<{ quizId: string }> {
	return send('/api/quizzes/generate', {
		method: 'POST',
		body: JSON.stringify(filters)
	});
}

export async function createSession(body: CreateSessionBody): Promise<SessionManifest> {
	return send('/api/sessions', {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

export async function postRoundStart(sessionId: string, position: number): Promise<void> {
	await send<void>(`/api/sessions/${sessionId}/rounds/${position}/start`, {
		method: 'POST'
	});
}

export async function postRoundResult(sessionId: string, body: RoundResultBody): Promise<void> {
	await send<void>(`/api/sessions/${sessionId}/rounds/${body.position}/result`, {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

export async function finalizeSession(
	sessionId: string,
	body: FinalizeSessionBody
): Promise<FinalizeResult> {
	return send(`/api/sessions/${sessionId}/finalize`, {
		method: 'POST',
		body: JSON.stringify(body)
	});
}
