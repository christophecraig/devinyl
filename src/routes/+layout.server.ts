/**
 * Root layout load — exposes whether the request carries a signed-in session
 * so the shell nav (+layout.svelte) can show Sign in vs Account without a
 * client-side probe. `locals.userId` is already resolved per-request by
 * hooks.server.ts; this just forwards it as page data.
 *
 * Also the single enforcement point for `/complete-profile` (see
 * `auth.ts`'s module doc on the OAuth/age-gate split): a signed-in user with
 * `birthYear IS NULL` gets redirected here from anywhere in the app until
 * they finish it, and — the mirror case — a complete profile visiting
 * `/complete-profile` directly gets sent back out, so the page never sits
 * around pointlessly once there's nothing left to complete. This only ever
 * runs for page navigations (SvelteKit layouts don't wrap `+server.ts`
 * routes), so `/api/*` calls are never touched by it.
 *
 * `googleEnabled` mirrors `auth.ts`'s own `socialProviders` gate (both
 * env vars present) so login/signup only render a "Continue with Google"
 * button once the provider is actually reachable, rather than one that
 * always 4xxs with Better Auth's own "Provider not found" until task 2.1's
 * credentials land.
 */
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { user } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const COMPLETE_PROFILE_PATH = '/complete-profile';

export const load: LayoutServerLoad = async ({ locals, platform, url }) => {
	const loggedIn = locals.userId !== null;
	const googleEnabled = Boolean(
		platform?.env?.GOOGLE_CLIENT_ID && platform?.env?.GOOGLE_CLIENT_SECRET
	);

	if (!loggedIn) {
		if (url.pathname === COMPLETE_PROFILE_PATH) redirect(303, '/login');
		return { loggedIn, googleEnabled };
	}

	// One extra indexed lookup per authenticated page navigation (never per
	// API call, see above) — same cost tier as the session lookup
	// hooks.server.ts already does on every request, and the only reliable
	// way to know: Better Auth's session payload isn't trusted for custom
	// fields anywhere else in this codebase either (see sessions/create.ts).
	let needsProfileCompletion = false;
	let currentDisplayName = '';
	if (platform?.env?.DB) {
		const db = getDb(platform);
		const [row] = await db
			.select({ birthYear: user.birthYear, displayName: user.displayName })
			.from(user)
			.where(eq(user.id, locals.userId as string))
			.limit(1);
		needsProfileCompletion = (row?.birthYear ?? null) === null;
		currentDisplayName = row?.displayName ?? '';
	}

	if (needsProfileCompletion && url.pathname !== COMPLETE_PROFILE_PATH) {
		redirect(303, COMPLETE_PROFILE_PATH);
	}
	if (!needsProfileCompletion && url.pathname === COMPLETE_PROFILE_PATH) {
		redirect(303, '/');
	}

	return {
		loggedIn,
		googleEnabled,
		currentDisplayName: needsProfileCompletion ? currentDisplayName : undefined
	};
};
