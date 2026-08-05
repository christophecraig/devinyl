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
 * `GOOGLE_CLIENT_SECRET` are set — task 2.1 is `[USER]`, so in every
 * environment today that's neither. **Known gap for whoever wires it**: a
 * Google sign-in has no `birthYear` to submit, so it will hit the same
 * `create.before` age gate and fail closed. Closing that gap needs a
 * post-OAuth "complete your profile" step this codebase doesn't have yet —
 * out of scope while the provider itself is unreachable.
 */

import { betterAuth, APIError } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { normalize } from '$lib/game/normalize.js';
import { MIN_SIGNUP_AGE } from '$lib/game/types.js';
import type { Db } from './db/index.js';
import * as schema from './db/schema.js';
import { user } from './db/schema.js';
import { isBlockedName, nameRejectionMessage } from './profanity.js';
import { sendEmail } from './email.js';

const MIN_DISPLAY_NAME_LENGTH = 2;
const MAX_DISPLAY_NAME_LENGTH = 24;

export interface AuthEnv {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	RESEND_API_KEY?: string;
}

function validateDisplayName(raw: unknown): string {
	const displayName = typeof raw === 'string' ? raw.trim() : '';
	if (displayName.length < MIN_DISPLAY_NAME_LENGTH || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
		throw new APIError('BAD_REQUEST', {
			message: `Display name must be between ${MIN_DISPLAY_NAME_LENGTH} and ${MAX_DISPLAY_NAME_LENGTH} characters.`
		});
	}
	if (isBlockedName(displayName)) {
		throw new APIError('BAD_REQUEST', { message: nameRejectionMessage() });
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
			? `That name is taken. Try "${suggestion}"?`
			: 'That name is taken. Please choose a different one.'
	});
}

/** LEGAL-1: 13+, enforced server-side, year-only. */
function assertOldEnough(birthYear: unknown): void {
	const year = typeof birthYear === 'number' ? birthYear : Number(birthYear);
	if (!Number.isInteger(year) || new Date().getUTCFullYear() - year < MIN_SIGNUP_AGE) {
		throw new APIError('BAD_REQUEST', {
			message: `You must be at least ${MIN_SIGNUP_AGE} years old to create an account.`
		});
	}
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
				birthYear: { type: 'number', required: true, input: true },
				extendedInput: { type: 'boolean', required: false, input: true, defaultValue: false },
				isOperator: { type: 'boolean', required: false, input: false, defaultValue: false }
			}
		},

		databaseHooks: {
			user: {
				create: {
					before: async (raw) => {
						const displayName = validateDisplayName(raw.displayName);
						assertOldEnough(raw.birthYear);
						const displayNameNormalized = normalize(displayName);
						await assertDisplayNameAvailable(db, displayName, displayNameNormalized);
						return { data: { ...raw, displayName, displayNameNormalized } };
					}
				},
				update: {
					before: async (partial) => {
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
