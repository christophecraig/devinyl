/**
 * LOC-1: the server's `{ code, message }` envelope (app.d.ts's `App.Error`)
 * is stable and machine-readable so the client can localize from `code`
 * rather than displaying the server's English `message` verbatim.
 */
import { m } from '$lib/paraglide/messages.js';
import type { ApiErrorCode } from './api.js';

export function localizeApiErrorCode(code: ApiErrorCode): string {
	switch (code) {
		case 'bad_request':
			return m.api_error_bad_request();
		case 'unauthorized':
			return m.api_error_unauthorized();
		case 'forbidden':
			return m.api_error_forbidden();
		case 'not_found':
			return m.api_error_not_found();
		case 'gone':
			return m.api_error_gone();
		case 'conflict':
			return m.api_error_conflict();
		case 'rate_limited':
			return m.api_error_rate_limited();
		case 'unavailable':
			return m.api_error_unavailable();
		case 'network_error':
			return m.api_error_network();
		case 'internal':
		default:
			return m.api_error_internal();
	}
}
