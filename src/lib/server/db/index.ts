import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = ReturnType<typeof getDb>;

/**
 * Bind a Drizzle instance to the D1 database for this request/job.
 * `platform` is SvelteKit's `App.Platform` (routes) or the equivalent object
 * built in src/worker/entry.ts for the `scheduled` handler — both expose
 * `env.DB` (the D1 binding declared in wrangler.jsonc).
 */
export function getDb(platform: App.Platform) {
	return drizzle(platform.env.DB, { schema });
}
