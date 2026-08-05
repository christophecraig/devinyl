/**
 * Server hooks — identity + locale resolution per request.
 *
 * Guests (§4) resolve from a client-generated id in `localStorage`, sent as
 * `x-guest-id`. Registered players (task 2.2) resolve from Better Auth's own
 * session cookie via `auth.api.getSession` — this hook never reads the
 * cookie itself, staying agnostic of Better Auth's cookie format. A missing
 * D1 binding (`vite dev` without the Cloudflare plugin) degrades to "no
 * session" rather than throwing, so every non-API page still renders.
 *
 * Locale (LOC-1) is URL-independent: `paraglideMiddleware` resolves it per
 * request from, in order, the `PARAGLIDE_LOCALE` cookie (set by the settings
 * language switcher), the `Accept-Language` header, then the English
 * baseline — see the `strategy` array passed to `paraglideVitePlugin` in
 * vite.config.ts. `%paraglide.lang%`/`%paraglide.textDirection%` in
 * app.html get filled in via `transformPageChunk`.
 */

import type { Handle, HandleServerError } from '@sveltejs/kit';
import { createAuth } from '$lib/server/auth.js';
import { getDb } from '$lib/server/db/index.js';
import { readGuestId } from '$lib/server/identity.js';
import { paraglideMiddleware } from '$lib/paraglide/server.js';
import { getTextDirection } from '$lib/paraglide/runtime.js';
import { captureError } from '$lib/server/observability.js';

const resolveIdentity: Handle = async ({ event, resolve }) => {
	event.locals.userId = null;
	event.locals.guestId = readGuestId(event.request);

	if (event.platform?.env?.DB) {
		try {
			const auth = createAuth(getDb(event.platform), event.platform.env);
			const session = await auth.api.getSession({ headers: event.request.headers });
			event.locals.userId = session?.user.id ?? null;
		} catch (err) {
			// A misconfigured Better Auth (e.g. a missing BETTER_AUTH_SECRET secret
			// on the deployed Worker) must not 500 every single request — degrade
			// to "no session", same as the missing-DB-binding case above.
			console.error('[hooks] session resolution failed', err);
		}
	}

	return resolve(event);
};

/**
 * Uncaught server-side errors (thrown out of `load`, an API route, etc.) —
 * separate from `handle` above, which only wraps identity/locale resolution
 * and never sees errors thrown further down the chain. This is plan 4.8's
 * hook point for Sentry: narrowest place that reports every uncaught error
 * without threading a captureError() call through `resolveIdentity` or every
 * route individually. `event.platform?.env?.SENTRY_DSN` is undefined until
 * `wrangler secret put SENTRY_DSN` is run (see src/lib/server/observability.ts
 * for what happens either way); `event.platform` itself can be undefined in
 * `vite dev` without the Cloudflare plugin, same guard as `resolveIdentity`.
 */
export const handleError: HandleServerError = ({ error, event, status }) => {
	// SvelteKit already logs expected errors (4xx from `error()`) without
	// calling this hook for most of them, but a thrown 4xx from a `load`
	// still lands here — only forward genuine 5xx-class failures to Sentry so
	// it doesn't fill up with routine "not found" traffic.
	if (status < 500) return;

	captureError(event.platform?.env?.SENTRY_DSN, error, {
		source: 'hooks.handleError',
		route: event.route?.id ?? event.url.pathname
	});
};

export const handle: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		event.locals.locale = locale;
		return resolveIdentity({
			event,
			resolve: (event, opts) =>
				resolve(event, {
					...opts,
					transformPageChunk: ({ html }) =>
						html
							.replace('%paraglide.lang%', locale)
							.replace('%paraglide.textDirection%', getTextDirection(locale))
				})
		});
	});
