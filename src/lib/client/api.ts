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
	ImportGuestBody,
	RoundResultBody
} from '$lib/game/schemas.js';
import type { Board, FinalizeResult, SessionManifest } from '$lib/game/types.js';
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

// ---------------------------------------------------------------------------
// Daily, challenges, boards (CHAL-1…4, DAILY-1/2/5, STAT-2, task 3.1/3.5/3.6)
// ---------------------------------------------------------------------------

export interface DailyInfo {
	day: string;
	dayNumber: number;
	quizId: string;
	rounds: number;
	isToday: boolean;
	alreadyPlayed: boolean;
}

export async function getDaily(day?: string): Promise<DailyInfo> {
	const qs = day ? `?day=${encodeURIComponent(day)}` : '';
	const { daily } = await send<{ daily: DailyInfo }>(`/api/daily${qs}`, { method: 'GET' });
	return daily;
}

export interface ChallengeLobby {
	token: string;
	quizId: string;
	quizName: string;
	rounds: number;
	challengerName: string;
	scoreToBeat: number;
}

export async function getChallengeLobby(token: string): Promise<ChallengeLobby> {
	const { lobby } = await send<{ lobby: ChallengeLobby }>(`/api/challenges/${token}`, {
		method: 'GET'
	});
	return lobby;
}

export async function createChallenge(sessionId: string): Promise<{ token: string }> {
	return send('/api/challenges', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export type BoardScopePath =
	| { kind: 'quiz'; quizId: string }
	| { kind: 'challenge'; token: string }
	| { kind: 'daily'; day?: string };

function boardPath(scope: BoardScopePath): string {
	if (scope.kind === 'quiz') return `/api/quizzes/${scope.quizId}/board`;
	if (scope.kind === 'challenge') return `/api/challenges/${scope.token}/board`;
	return `/api/daily/board${scope.day ? `?day=${encodeURIComponent(scope.day)}` : ''}`;
}

export async function getBoard(
	scope: BoardScopePath,
	opts: { friends?: boolean; mode?: 'speed' | 'fixed'; cursor?: string } = {}
): Promise<Board> {
	const path = boardPath(scope);
	const params = new URLSearchParams();
	if (opts.friends) params.set('friends', 'true');
	if (opts.mode) params.set('mode', opts.mode);
	if (opts.cursor) params.set('cursor', opts.cursor);
	const qs = params.toString();
	const sep = path.includes('?') ? '&' : '?';
	const { board } = await send<{ board: Board }>(`${path}${qs ? sep + qs : ''}`, { method: 'GET' });
	return board;
}

/** MET-1 anonymous funnel counters (plan §G-2) — fire-and-forget, never awaited by callers. */
export async function recordMetricEvent(
	kind: 'daily_share' | 'challenge_open' | 'quiz_open' | 'invite_open'
): Promise<void> {
	try {
		await send<void>('/api/metrics/event', { method: 'POST', body: JSON.stringify({ kind }) });
	} catch {
		// Best-effort — a dropped funnel beacon must never surface to the player.
	}
}

// ---------------------------------------------------------------------------
// Auth (§12, task 2.2) — Better Auth's own routes, called directly rather
// than through its client SDK: the server sets the session cookie on the
// response, same-origin, so there is nothing the SDK would add here.
// ---------------------------------------------------------------------------

export interface SignUpBody {
	email: string;
	password: string;
	displayName: string;
	birthYear: number;
	locale?: 'fr' | 'en';
}

export async function signUp(body: SignUpBody): Promise<{ user: { id: string } }> {
	return send('/api/auth/sign-up/email', {
		method: 'POST',
		body: JSON.stringify({ ...body, name: body.displayName })
	});
}

export async function signIn(body: { email: string; password: string }): Promise<unknown> {
	return send('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify(body) });
}

export async function signOut(): Promise<void> {
	await send<void>('/api/auth/sign-out', { method: 'POST' });
}

/**
 * Google sign-in (ACC-3). Better Auth's `/sign-in/social` doesn't set a
 * session itself — it hands back an authorize URL on Google's own domain,
 * and the actual sign-in completes when Google redirects back to
 * `/api/auth/callback/google` (see `auth.ts`'s module doc for what happens
 * to a first-time signer there). A full navigation, not a `fetch`.
 */
export async function signInWithGoogle(): Promise<void> {
	const { url } = await send<{ url: string }>('/api/auth/sign-in/social', {
		method: 'POST',
		body: JSON.stringify({ provider: 'google', callbackURL: '/' })
	});
	location.assign(url);
}

/**
 * `/complete-profile` — closes the OAuth/age-gate gap `auth.ts`'s module doc
 * describes: a Google sign-in has no birth year to submit at account
 * creation, so it's collected here instead, through Better Auth's own
 * `update-user` route (runs the same `assertOldEnough`/`validateDisplayName`
 * hooks the credential signup path always ran, just later).
 */
export async function completeProfile(body: {
	displayName: string;
	birthYear: number;
}): Promise<unknown> {
	return send('/api/auth/update-user', { method: 'POST', body: JSON.stringify(body) });
}

/** ACC-4 — imports the local guest blob once, right after sign-up. */
export async function importGuestHistory(body: ImportGuestBody): Promise<{
	reattributedSessions: number;
	demotedToReplay: number;
	importedHistoryRows: number;
}> {
	return send('/api/me/import-guest', { method: 'POST', body: JSON.stringify(body) });
}
