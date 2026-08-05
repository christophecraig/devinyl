/**
 * Better Auth's own routes — `/api/auth/sign-up/email`, `/sign-in/email`,
 * `/sign-in/social`, `/sign-out`, `/verify-email`, `/reset-password`, etc.
 * (§12, plan task 2.2). This app never re-implements any of them; it just
 * hands the raw `Request` to Better Auth's handler and returns its `Response`.
 */

import type { RequestHandler } from './$types';
import { createAuth } from '$lib/server/auth.js';
import { getDb } from '$lib/server/db/index.js';
import { requirePlatform } from '$lib/server/http.js';

const handle: RequestHandler = async ({ request, platform }) => {
	const env = requirePlatform(platform);
	const auth = createAuth(getDb(env), env.env);
	return auth.handler(request);
};

export const GET = handle;
export const POST = handle;
