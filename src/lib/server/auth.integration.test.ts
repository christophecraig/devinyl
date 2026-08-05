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
import { parseAdditionalUserInputFromProviderProfile } from 'better-auth/db';
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

	/**
	 * `/complete-profile`'s only server-side enforcement: `update.before`
	 * running the exact same `assertOldEnough` the credential signup path
	 * always ran, just at update time instead of create time (auth.ts's
	 * module doc). The OAuth *creation* path itself (`create.before`'s
	 * `context.path !== '/sign-up/email'` branch) isn't exercised here — it
	 * would need a mocked Google token/userinfo exchange to reach through
	 * Better Auth's real `/callback/google` handler, which is out of scope
	 * for this pass; the branch is covered by manual verification once
	 * task 2.1's Google credentials are live (same posture as 1.31/4.13's
	 * real-device gaps).
	 */
	function cookieHeaderFrom(res: Response): string {
		return res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
	}

	/**
	 * `requireEmailVerification: true` means sign-up itself sets no session
	 * cookie (Better Auth withholds it until verification) — so getting an
	 * authenticated session for these tests means verifying, then signing in
	 * for real, rather than reusing sign-up's response directly.
	 */
	async function signInAndGetCookie(
		auth: ReturnType<typeof createAuth>,
		email: string
	): Promise<string> {
		await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
		const signInRes = await auth.handler(
			new Request('http://localhost:5173/api/auth/sign-in/email', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
				body: JSON.stringify({ email, password: 'correct horse battery staple' })
			})
		);
		expect(signInRes.status).toBeLessThan(300);
		return cookieHeaderFrom(signInRes);
	}

	it('rejects setting a birth year under 13 via update-user (LEGAL-1, complete-profile path)', async () => {
		const auth = createAuth(db, AUTH_ENV);
		const signUpRes = await signUp({ email: 'birthday@example.test' });
		expect(signUpRes.status).toBeLessThan(300);
		const cookie = await signInAndGetCookie(auth, 'birthday@example.test');

		const res = await auth.handler(
			new Request('http://localhost:5173/api/auth/update-user', {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:5173' },
				body: JSON.stringify({ birthYear: new Date().getUTCFullYear() - 10 })
			})
		);
		expect(res.status).toBe(400);

		const [row] = await db.select().from(user).where(eq(user.email, 'birthday@example.test'));
		// The already-valid signup birthYear must survive a rejected update —
		// assertOldEnough throws before any write happens.
		expect(row.birthYear).toBe(new Date().getUTCFullYear() - 20);
	});

	it('accepts a valid birth year via update-user, closing out a null birthYear', async () => {
		const auth = createAuth(db, AUTH_ENV);
		const signUpRes = await signUp({ email: 'complete@example.test' });
		expect(signUpRes.status).toBeLessThan(300);
		const cookie = await signInAndGetCookie(auth, 'complete@example.test');

		// Simulates the moment `/complete-profile` closes: a row with
		// birthYear NULL (as an OAuth bootstrap would leave it) gets a valid
		// year written through the exact same endpoint that page calls.
		await db.update(user).set({ birthYear: null }).where(eq(user.email, 'complete@example.test'));

		const res = await auth.handler(
			new Request('http://localhost:5173/api/auth/update-user', {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:5173' },
				body: JSON.stringify({ birthYear: new Date().getUTCFullYear() - 20 })
			})
		);
		expect(res.status).toBeLessThan(300);

		const [row] = await db.select().from(user).where(eq(user.email, 'complete@example.test'));
		expect(row.birthYear).toBe(new Date().getUTCFullYear() - 20);
	});

	/**
	 * Regression for the framework-level gap the manual-verification note
	 * above didn't catch: Better Auth validates `additionalFields.required`
	 * against the raw OAuth provider profile in
	 * `parseAdditionalUserInputFromProviderProfile` (better-auth's own
	 * oauth2/link-account.mjs, called before `create.before` ever runs).
	 * Google's userinfo response has no `displayName` claim, so a
	 * `required: true` on that field throws "displayName is required" on
	 * every real Google sign-up — `deriveOAuthDisplayName` in `create.before`
	 * never gets a chance to bootstrap one. This reproduces the exact call
	 * Better Auth's real `/callback/google` handler makes, without needing a
	 * mocked token/userinfo exchange.
	 */
	it('bootstraps a displayName for an OAuth profile with no displayName claim (Google sign-up)', async () => {
		const auth = createAuth(db, AUTH_ENV);
		const { internalAdapter, options } = await auth.$context;

		const providerProfile = { locale: 'fr' };
		const additionalUserFields = parseAdditionalUserInputFromProviderProfile(
			options,
			providerProfile,
			'create'
		);

		await internalAdapter.createOAuthUser(
			{
				name: 'Jamie Rivera',
				image: null,
				...additionalUserFields,
				email: 'jamie@example.test',
				emailVerified: true
			},
			{
				accessToken: 'test-token',
				providerId: 'google',
				accountId: 'google-subject-id'
			}
		);

		const [row] = await db.select().from(user).where(eq(user.email, 'jamie@example.test'));
		expect(row.displayName).toBeTruthy();
		expect(row.birthYear).toBeNull();
	});
});
