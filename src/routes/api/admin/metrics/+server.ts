/**
 * `GET /api/admin/metrics` — MET-1/2, plan task 3.11. Operator-gated.
 *
 * Returns `metrics_daily` (the nightly aggregation, `$lib/server/metrics.ts`)
 * for the last `days`, reshaped from `(day, metric, value)` rows into one
 * object per day so the dashboard doesn't have to pivot client-side.
 */

import { and, gte } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index.js';
import { metricsDaily } from '$lib/server/db/schema.js';
import { json, requirePlatform } from '$lib/server/http.js';
import { requireOperator } from '$lib/server/identity.js';
import { parisDayOffset } from '$lib/server/time.js';

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = requirePlatform(platform);
	const db = getDb(env);
	await requireOperator(db, locals);

	const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
	const from = parisDayOffset(Date.now(), -days);

	const rows = await db
		.select()
		.from(metricsDaily)
		.where(and(gte(metricsDaily.day, from)));

	const byDay = new Map<string, Record<string, number>>();
	for (const row of rows) {
		const entry = byDay.get(row.day) ?? {};
		entry[row.metric] = row.value;
		byDay.set(row.day, entry);
	}

	const series = [...byDay.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([day, metrics]) => ({ day, metrics }));

	return json({ series });
};
