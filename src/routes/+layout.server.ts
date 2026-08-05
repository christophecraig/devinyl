/**
 * Root layout load — exposes whether the request carries a signed-in session
 * so the shell nav (+layout.svelte) can show Sign in vs Account without a
 * client-side probe. `locals.userId` is already resolved per-request by
 * hooks.server.ts; this just forwards it as page data.
 */
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return { loggedIn: locals.userId !== null };
};
