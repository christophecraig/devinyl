/**
 * Server hooks — identity resolution per request.
 *
 * Guests (§4) resolve from a client-generated id in `localStorage`, sent as
 * `x-guest-id`. Registered players (task 2.2) resolve from Better Auth's own
 * session cookie via `auth.api.getSession` — this hook never reads the
 * cookie itself, staying agnostic of Better Auth's cookie format. A missing
 * D1 binding (`vite dev` without the Cloudflare plugin) degrades to "no
 * session" rather than throwing, so every non-API page still renders.
 *
 * Locale detection (LOC-1) lands with Paraglide in task S.5.
 */

import type { Handle } from '@sveltejs/kit';
import { createAuth } from '$lib/server/auth.js';
import { getDb } from '$lib/server/db/index.js';
import { readGuestId } from '$lib/server/identity.js';

export const handle: Handle = async ({ event, resolve }) => {
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
