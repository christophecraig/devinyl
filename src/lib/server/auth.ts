/**
 * Better Auth instance — technical-spec §12, plan task 2.2.
 *
 * Built per-request from the D1-bound `Db`, the same shape as `getDb()` /
 * `getProvider()` elsewhere in `server/`: Workers isolates don't share a
 * process, and the alternative (a module-level singleton closing over a
 * binding captured at cold start) is exactly the footgun `catalog/deezer.ts`'s
 * queue comment already warns about for this codebase.
 *
 * Everything below Better Auth's own `user`/`session`/`account`/`verification`
 * tables is this app's extension surface (§6): `displayName` uniqueness
 * (ACC-5), the 13+ signup gate (LEGAL-1), and the profanity filter (FAIR-5)
 * all have to run **inside** Better Auth's lifecycle, because
 * `/api/auth/sign-up/email` — not a route this codebase owns — is the actual
 * write point. `databaseHooks.user.create.before` is where that happens; it
 * closes over the same `db` passed in, so the checks are plain Drizzle
 * queries like everywhere else in this codebase, not the adapter's generic
 * `Where` DSL.
 *
 * Google (ACC-3) is only registered when both `GOOGLE_CLIENT_ID` and
 * `GOOGLE_CLIENT_SECRET` are set — task 2.1 is `[USER]`.
 *
 * **The OAuth/age-gate split.** Google never hands back a birth year, so the
 * `create.before` hook cannot run the same strict check it runs for
 * `/sign-up/email` — there is nothing to check yet, and throwing here would
 * silently drop the OAuth callback with no user or account row ever created
 * (`createOAuthUser` calls straight into `createWithHooks`; a hook throw
 * propagates with nothing to roll back, but also nothing to recover from —
 * the player just bounces off a dead sign-in button). `context?.path` is
 * Better Auth's own established way to tell providers apart inside a single
 * shared hook (its `username` plugin does the same `context.path ===
 * "/sign-up/email"` check) — only that one path gets the full strict
 * validation; everything else (in practice, only the Google callback while
 * this app has one social provider) gets a lenient bootstrap that can never
 * fail closed: `displayName` is derived from the provider's name and
 * de-collided automatically (never surfaced as a signup error — there is no
 * form yet for an OAuth user to correct it on), and `birthYear` is left
 * unset. The account exists but is incomplete; `birthYear IS NULL` doubles
 * as that flag (no separate column) and `/complete-profile` (root
 * `+layout.server.ts`) is where every signed-in request gets redirected
 * until it's filled in via `POST /api/auth/update-user`, which runs back
 * through `update.before` below — the same `assertOldEnough` the credential
 * path always ran, just at a different point in the flow. See plan §G-24.
 */

import { betterAuth, APIError } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { normalize } from '$lib/game/normalize.js';
import { MIN_SIGNUP_AGE } from '$lib/game/types.js';
import { m } from '$lib/paraglide/messages.js';
import type { Db } from './db/index.js';
import * as schema from './db/schema.js';
import { user } from './db/schema.js';
import { isBlockedName } from './profanity.js';
import { sendEmail } from './email.js';

const MIN_DISPLAY_NAME_LENGTH = 2;
const MAX_DISPLAY_NAME_LENGTH = 24;
const OAUTH_FALLBACK_DISPLAY_NAME = 'Player';

export interface AuthEnv {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	RESEND_API_KEY?: string;
}

function validateDisplayName(raw: unknown): string {
	const displayName = typeof raw === 'string' ? raw.trim() : '';
	if (
		displayName.length < MIN_DISPLAY_NAME_LENGTH ||
		displayName.length > MAX_DISPLAY_NAME_LENGTH
	) {
		throw new APIError('BAD_REQUEST', {
			message: m.auth_error_display_name_length({
				min: MIN_DISPLAY_NAME_LENGTH,
				max: MAX_DISPLAY_NAME_LENGTH
			})
		});
	}
	if (isBlockedName(displayName)) {
		throw new APIError('BAD_REQUEST', { message: m.auth_error_display_name_blocked() });
	}
	return displayName;
}

/**
 * ACC-5: on a normalized-name collision, suggest the first free
 * `${displayName}${n}` rather than silently failing or silently renaming.
 * `excludeUserId` lets a profile edit collide with the account's own row
 * without tripping over itself.
 */
async function suggestAvailableDisplayName(
	db: Db,
	displayName: string,
	excludeUserId?: string
): Promise<string | null> {
	for (let n = 2; n < 100; n++) {
		const candidate = `${displayName}${n}`;
		const candidateNormalized = normalize(candidate);
		const [row] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.displayNameNormalized, candidateNormalized))
			.limit(1);
		if (!row || row.id === excludeUserId) return candidate;
	}
	return null;
}

/** Throws a friendly `CONFLICT` (with a suggestion) if `displayNameNormalized` is taken by someone else. */
async function assertDisplayNameAvailable(
	db: Db,
	displayName: string,
	displayNameNormalized: string,
	excludeUserId?: string
): Promise<void> {
	const [collision] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.displayNameNormalized, displayNameNormalized))
		.limit(1);
	if (!collision || collision.id === excludeUserId) return;

	const suggestion = await suggestAvailableDisplayName(db, displayName, excludeUserId);
	throw new APIError('CONFLICT', {
		message: suggestion
			? m.auth_error_display_name_taken_suggestion({ suggestion })
			: m.auth_error_display_name_taken()
	});
}

/** LEGAL-1: 13+, enforced server-side, year-only. */
function assertOldEnough(birthYear: unknown): void {
	const year = typeof birthYear === 'number' ? birthYear : Number(birthYear);
	if (!Number.isInteger(year) || new Date().getUTCFullYear() - year < MIN_SIGNUP_AGE) {
		throw new APIError('BAD_REQUEST', {
			message: m.auth_error_age_gate({ age: MIN_SIGNUP_AGE })
		});
	}
}

/**
 * OAuth bootstrap for `displayName` (see module doc) — never throws, always
 * returns something valid and free. `rawName` is the provider's own name
 * claim (Google: `raw.name`, mapped by Better Auth's base `User` schema
 * before this hook runs); anything unusable collapses to a fixed fallback
 * rather than surfacing a signup error there is no form to show it on yet.
 */
async function deriveOAuthDisplayName(
	db: Db,
	rawName: unknown
): Promise<{ displayName: string; displayNameNormalized: string }> {
	let base = typeof rawName === 'string' ? rawName.trim() : '';
	if (base.length < MIN_DISPLAY_NAME_LENGTH) base = OAUTH_FALLBACK_DISPLAY_NAME;
	if (base.length > MAX_DISPLAY_NAME_LENGTH) base = base.slice(0, MAX_DISPLAY_NAME_LENGTH);
	if (isBlockedName(base)) base = OAUTH_FALLBACK_DISPLAY_NAME;

	const [collision] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.displayNameNormalized, normalize(base)))
		.limit(1);
	if (!collision) return { displayName: base, displayNameNormalized: normalize(base) };

	// Taken — ACC-5's own suggestion loop, just applied automatically instead
	// of asking the player (there's no UI to ask on yet). A 4-digit random
	// suffix is the fallback for the vanishingly unlikely case every
	// `${base}2..99` slot from `suggestAvailableDisplayName` is also taken.
	const suggestion = await suggestAvailableDisplayName(db, base);
	const displayName = suggestion ?? `${base}${Math.floor(1000 + Math.random() * 9000)}`;
	return { displayName, displayNameNormalized: normalize(displayName) };
}

export function createAuth(db: Db, env: AuthEnv) {
	return betterAuth({
		database: drizzleAdapter(db, { provider: 'sqlite', schema, transaction: false }),
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		trustedOrigins: [env.BETTER_AUTH_URL],

		// 30-day rolling session (§12). `HttpOnly`/`SameSite=Lax` are Better
		// Auth's own defaults; `Secure` is auto-set from `baseURL`'s protocol.
		session: {
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24
		},

		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			sendResetPassword: async ({ user: recipient, url }) => {
				await sendEmail(env.RESEND_API_KEY, {
					to: recipient.email,
					subject: 'Reset your Devinyl password',
					html: `<p>Click <a href="${url}">here</a> to reset your password. If you didn't ask for this, ignore this email.</p>`
				});
			}
		},

		emailVerification: {
			sendOnSignUp: true,
			sendVerificationEmail: async ({ user: recipient, url }) => {
				await sendEmail(env.RESEND_API_KEY, {
					to: recipient.email,
					subject: 'Verify your Devinyl account',
					html: `<p>Click <a href="${url}">here</a> to verify your email.</p>`
				});
			}
		},

		socialProviders:
			env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET
						}
					}
				: undefined,

		user: {
			additionalFields: {
				displayName: { type: 'string', required: true, input: true },
				displayNameNormalized: { type: 'string', required: false, input: false },
				avatarUrl: { type: 'string', required: false, input: true },
				locale: { type: 'string', required: false, input: true, defaultValue: 'fr' },
				// Not `required: true`: the credential path's own requirement is
				// enforced by `create.before`'s `assertOldEnough` below regardless
				// of this flag, and OAuth accounts genuinely have no value to give
				// at creation time — a framework-level required check here would
				// have nothing to gate on but the field's mere presence, and could
				// only get in the way of the OAuth path's deferred-completion
				// design (module doc), never usefully strengthen the credential
				// path's own hook-enforced check.
				birthYear: { type: 'number', required: false, input: true },
				extendedInput: { type: 'boolean', required: false, input: true, defaultValue: false },
				isOperator: { type: 'boolean', required: false, input: false, defaultValue: false }
			}
		},

		databaseHooks: {
			user: {
				create: {
					before: async (raw, context) => {
						if (context?.path === '/sign-up/email') {
							const displayName = validateDisplayName(raw.displayName);
							assertOldEnough(raw.birthYear);
							const displayNameNormalized = normalize(displayName);
							await assertDisplayNameAvailable(db, displayName, displayNameNormalized);
							return { data: { ...raw, displayName, displayNameNormalized } };
						}

						// OAuth bootstrap (module doc) — never throws, birthYear stays unset.
						const { displayName, displayNameNormalized } = await deriveOAuthDisplayName(
							db,
							raw.displayName ?? raw.name
						);
						return { data: { ...raw, displayName, displayNameNormalized } };
					}
				},
				update: {
					before: async (partial) => {
						// The completion step (and any future birth-year edit) runs the
						// exact same age gate the credential signup path always ran —
						// just deferred to whenever `birthYear` actually gets set.
						if (typeof partial.birthYear !== 'undefined') {
							assertOldEnough(partial.birthYear);
						}
						if (typeof partial.displayName !== 'string') return;
						const displayName = validateDisplayName(partial.displayName);
						const displayNameNormalized = normalize(displayName);
						const excludeUserId = typeof partial.id === 'string' ? partial.id : undefined;
						await assertDisplayNameAvailable(db, displayName, displayNameNormalized, excludeUserId);
						return { data: { ...partial, displayName, displayNameNormalized } };
					}
				}
			}
		}
	});
}
