/**
 * Error capture — plan 4.8. Every unexpected-error call site should go
 * through `captureError()` instead of a bare `console.error()`, so nothing
 * needs its own `if (dsn)` branch — same "module absorbs the optionality"
 * convention as `sendEmail()` in `./email.ts` (RESEND_API_KEY) and Google
 * OAuth registration in `./auth.ts` (GOOGLE_CLIENT_ID/SECRET): the [USER]
 * credential is a plain optional param, and its absence degrades instead of
 * throwing.
 *
 * `SENTRY_DSN` is `[USER]` the same way — see docs/implementation-plan.md §L.
 * Until `wrangler secret put SENTRY_DSN` is run, `captureError()` only logs
 * to console (still visible via `wrangler tail`, docs/runbooks/logs.md);
 * once it's set, every call below starts also forwarding to Sentry with no
 * code change required anywhere else.
 *
 * DELIBERATELY NOT using the `@sentry/cloudflare` SDK package: 4.8 was built
 * while two sibling tasks (4.3, 4.4) were mid-flight on this checkout's
 * package.json, and installing a dependency here would race them. Sentry's
 * ingestion API accepts plain HTTP (the "envelope" endpoint every SDK POSTs
 * to under the hood), so this talks to it directly over `fetch` — zero
 * install, fully Workers-native. If/when `@sentry/cloudflare` (^10, confirmed
 * current name as of this writing) gets installed, `sendToSentry` below is
 * the only function that would need replacing with the SDK's
 * `captureException` — `captureError()`'s signature and every call site stay
 * the same either way.
 */

export interface CaptureContext {
	/** Where the error was caught — e.g. 'hooks.handleError', 'jobs:daily'. */
	source: string;
	[key: string]: unknown;
}

interface ParsedDsn {
	ingestUrl: string;
	publicKey: string;
}

/**
 * A Sentry DSN looks like `https://<publicKey>@<host>/<projectId>` (or
 * `https://<publicKey>@<host>/<path>/<projectId>` for self-hosted/relay
 * setups) — the "envelope" endpoint every official SDK posts to is
 * `{scheme}://{host}/api/{projectId}/envelope/`.
 */
function parseDsn(dsn: string): ParsedDsn | null {
	try {
		const url = new URL(dsn);
		const projectId = url.pathname.replace(/^\//, '').split('/').filter(Boolean).pop();
		if (!url.username || !projectId) return null;
		return {
			ingestUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
			publicKey: url.username
		};
	} catch {
		return null;
	}
}

function sendToSentry(dsn: string, err: unknown, context: CaptureContext): void {
	const parsed = parseDsn(dsn);
	if (!parsed) {
		console.error('[observability] SENTRY_DSN is set but not a valid DSN, skipping Sentry send');
		return;
	}

	const message = err instanceof Error ? err.message : String(err);
	const eventId = crypto.randomUUID().replace(/-/g, '');
	const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
	const itemHeader = JSON.stringify({ type: 'event' });
	const eventPayload = JSON.stringify({
		event_id: eventId,
		timestamp: Date.now() / 1000,
		platform: 'node',
		level: 'error',
		message,
		exception:
			err instanceof Error
				? { values: [{ type: err.name, value: err.message, stacktrace: undefined }] }
				: undefined,
		extra: context
	});
	const body = `${envelopeHeader}\n${itemHeader}\n${eventPayload}\n`;

	// Fire-and-forget on purpose — reporting an error must never be the thing
	// that slows down (or breaks) the request/job that hit it. Callers running
	// inside a `scheduled` handler pass this through `ctx.waitUntil` themselves
	// if they want the isolate kept alive long enough for it to land (see
	// worker/entry.ts).
	fetch(parsed.ingestUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=devinyl-observability/1.0, sentry_key=${parsed.publicKey}`
		},
		body
	}).catch((sendErr) => {
		console.error('[observability] failed to reach Sentry ingest endpoint', sendErr);
	});
}

/**
 * Capture an unexpected error: always logs to console (unchanged from the
 * pre-4.8 convention across hooks.server.ts / lib/server/**), and also
 * forwards to Sentry when `dsn` is set. Never throws — a broken observability
 * path must not become a second failure on top of the one it's reporting.
 */
export function captureError(dsn: string | undefined, err: unknown, context: CaptureContext): void {
	console.error(`[observability:${context.source}]`, err);

	if (!dsn) return;

	try {
		sendToSentry(dsn, err, context);
	} catch (captureErr) {
		console.error('[observability] captureError failed', captureErr);
	}
}
