/**
 * Application ID generation — technical-spec §6.
 *
 * The spec calls these "nanoid(12)" / "nanoid(10)"; this is that algorithm
 * without the dependency. `crypto.getRandomValues` is a web standard present in
 * both the Workers runtime and browsers, and the alphabet is nanoid's own
 * URL-safe set, so the ids are interchangeable with the library's and match
 * `idSchema` / `challengeTokenSchema` in `game/schemas.ts`.
 *
 * The alphabet is 64 characters, a power of two, so masking the low 6 bits of
 * each random byte is uniform — no modulo bias, and no rejection loop.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomId(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let id = '';
	for (const byte of bytes) id += ALPHABET[byte & 63];
	return id;
}

/** Quiz, session, and imported-history ids (§6). */
export const newId = (): string => randomId(12);

/**
 * Challenge tokens (§6). Shorter because they live in a URL people paste into
 * a chat, and unguessability at 10 characters of a 64-symbol alphabet is 60
 * bits — far beyond anything worth brute-forcing for a quiz link.
 */
export const newChallengeToken = (): string => randomId(10);
