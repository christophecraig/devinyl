/**
 * Server hooks — identity resolution per request.
 *
 * Phase 1 resolves guests only (§4): a client-generated id in `localStorage`,
 * sent as `x-guest-id`. `locals.userId` is populated by Better Auth in Phase 2
 * (task 2.2); until then it is always null and every route takes the guest
 * branch. Both live on `locals` from day one so no route has to change shape
 * when accounts arrive.
 *
 * Locale detection (LOC-1) lands with Paraglide in task S.5.
 */

import type { Handle } from '@sveltejs/kit';
import { readGuestId } from '$lib/server/identity.js';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.userId = null;
	event.locals.guestId = readGuestId(event.request);

	return resolve(event);
};
