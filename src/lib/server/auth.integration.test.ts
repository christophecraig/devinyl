/**
 * Better Auth wiring — technical-spec §12, plan task 2.2.
 *
 * Exercises the real handler (`auth.handler`, the same thing
 * `/api/auth/[...auth]/+server.ts` calls) rather than re-testing Better
 * Auth's own internals: sign-up through the actual HTTP surface, so the
 * `databaseHooks` (ACC-5 uniqueness, LEGAL-1 age gate, FAIR-5 profanity) are
 * proven against Better Auth's real request/response shape, not a guess at
 * its internal API.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuth } from './auth.js';
import { user } from './db/schema.js';
import { ensureMigrations, resetDb, testDb } from './test-utils.integration.js';

const db = testDb();
const AUTH_ENV = {
	BETTER_AUTH_SECRET: 'test-secret-at-least-32-bytes-long!!',
	BETTER_AUTH_URL: 'http://localhost:5173'
};

function signUp(overrides: Partial<Record<string, unknown>> = {}) {
	const auth = createAuth(db, AUTH_ENV);
	return auth.handler(
		new Request('http://localhost:5173/api/auth/sign-up/email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'alex@example.test',
				password: 'correct horse battery staple',
				name: 'Alex',
				displayName: 'Alex',
				birthYear: new Date().getUTCFullYear() - 20,
				...overrides
			})
		})
	);
}

describe('Better Auth (task 2.2)', () => {
	beforeAll(async () => {
		await ensureMigrations();
	});

	beforeEach(async () => {
		await resetDb(db);
	});

	it('signs up, computing displayNameNormalized and defaulting isOperator/extendedInput', async () => {
		const res = await signUp();
		if (res.status >= 300) console.error(await res.clone().text());
		expect(res.status).toBeLessThan(300);

		const [row] = await db.select().from(user).where(eq(user.email, 'alex@example.test'));
		expect(row.displayName).toBe('Alex');
		expect(row.displayNameNormalized).toBe('alex');
		expect(row.isOperator).toBe(false);
		expect(row.extendedInput).toBe(false);
	});

	it('rejects a signup under 13 (LEGAL-1)', async () => {
		const res = await signUp({ birthYear: new Date().getUTCFullYear() - 10 });
		expect(res.status).toBe(400);

		const rows = await db.select().from(user);
		expect(rows).toHaveLength(0);
	});

	it('rejects a blocked display name (FAIR-5)', async () => {
		const res = await signUp({ displayName: 'connard' });
		expect(res.status).toBe(400);

		const rows = await db.select().from(user);
		expect(rows).toHaveLength(0);
	});

	it('rejects a display-name collision with a suggestion (ACC-5)', async () => {
		const first = await signUp({ email: 'first@example.test', displayName: 'Sam' });
		expect(first.status).toBeLessThan(300);

		const second = await signUp({ email: 'second@example.test', displayName: 'Sam' });
		expect(second.status).toBe(409);
		const body = (await second.json()) as { message: string };
		expect(body.message).toContain('Sam2');
	});

	it('is case/diacritic-insensitive on the collision check (ACC-5)', async () => {
		const first = await signUp({ email: 'first@example.test', displayName: 'Émile' });
		expect(first.status).toBeLessThan(300);

		const second = await signUp({ email: 'second@example.test', displayName: 'emile' });
		expect(second.status).toBe(409);
	});
});
