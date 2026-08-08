/**
 * `GET /api/admin/availability` — §5.3 / §G-5, plan task 4.2.
 *
 * The `/admin` half of the operator alert channel (the other half is the
 * Resend email `jobs/availability.ts` sends). Derived from existing columns,
 * not from an incident table — see `listAvailabilityIncidents`.
 */

import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { listAvailabilityIncidents } from '$lib/server/admin/index.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireOperator } from '$lib/server/identity.js';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);

	await requireOperator(db, locals);
	const incidents = await listAvailabilityIncidents(db);
	return json({ incidents });
};
