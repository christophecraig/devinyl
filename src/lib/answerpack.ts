/**
 * Encrypted per-round answer packs — technical-spec §7.2.
 *
 * The session manifest carries **zero plaintext answer data** (MUS-4). Each
 * round's accepted answers and reveal metadata travel as an AES-GCM blob whose
 * key the client derives locally as `HKDF(sessionSeed, position)`. The seed
 * ships in the manifest, so:
 *
 *   - keys never touch the network during play, and
 *   - neither validation nor reveal can be blocked by a connection drop (MUS-7).
 *
 * **This is obfuscation, not security, and always was.** Anyone can derive every
 * key up front from the seed. That is fine: FAIR-4 concedes determined cheaters
 * exist, and the authoritative defence is server re-validation at finalize
 * (§7.3). Coupling key delivery to the round-start beacon would have bought
 * nothing while making the beacon load-bearing for gameplay — which is exactly
 * what §7.2 (v1.1) moved away from, and why the beacon now returns nothing.
 *
 * Lives outside `src/lib/game/` deliberately: that directory is contractually
 * pure and synchronous, and this module is async and leans on Web Crypto.
 * Web Crypto is a web standard present in both the Workers runtime and the
 * browser, so this file is still fully isomorphic.
 */

import type { RoundPack } from './game/types.js';

const KEY_INFO_PREFIX = 'devinyl/round/';
const AES_KEY_BITS = 256;
const IV_BYTES = 12; // 96-bit nonce, the AES-GCM standard
const SEED_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// base64url — no padding, URL- and JSON-safe
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Returns `Uint8Array<ArrayBuffer>` rather than the default
 * `Uint8Array<ArrayBufferLike>`: Web Crypto's `BufferSource` excludes
 * `SharedArrayBuffer`-backed views, so the narrower type is what actually
 * satisfies `crypto.subtle`.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Fresh session seed — the only secret in the scheme, and only for the length of a session. */
export function generateSessionSeed(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(SEED_BYTES)));
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * `HKDF(sessionSeed, position)` → an AES-GCM key for one round.
 *
 * Runs identically on the server (to encrypt at manifest time) and in the
 * browser (to decrypt at validation and reveal time).
 */
export async function deriveRoundKey(sessionSeed: string, position: number): Promise<CryptoKey> {
	const seedBytes = fromBase64Url(sessionSeed);

	const material = await crypto.subtle.importKey('raw', seedBytes, 'HKDF', false, ['deriveKey']);

	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			// The seed is already high-entropy random, so an empty salt is correct
			// here — `info` is what separates one round's key from another's.
			salt: new Uint8Array(0),
			info: encoder.encode(`${KEY_INFO_PREFIX}${position}`)
		},
		material,
		{ name: 'AES-GCM', length: AES_KEY_BITS },
		false,
		['encrypt', 'decrypt']
	);
}

// ---------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------

/**
 * Encrypt one round's pack. Server-side, at manifest build time (§7.1).
 *
 * The IV is prepended to the ciphertext so the whole pack is one opaque string
 * in the manifest.
 */
export async function sealRoundPack(
	sessionSeed: string,
	position: number,
	pack: RoundPack
): Promise<string> {
	const key = await deriveRoundKey(sessionSeed, position);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(pack)))
	);

	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv, 0);
	combined.set(ciphertext, iv.length);
	return toBase64Url(combined);
}

/**
 * Decrypt one round's pack. Client-side, at clip start (for local validation)
 * and at reveal (ROUND-4).
 *
 * Throws on a tampered or mismatched pack — AES-GCM authenticates, so a
 * corrupted blob fails loudly rather than yielding garbage answers.
 */
export async function openRoundPack(
	sessionSeed: string,
	position: number,
	sealed: string
): Promise<RoundPack> {
	const key = await deriveRoundKey(sessionSeed, position);
	const combined = fromBase64Url(sealed);

	if (combined.length <= IV_BYTES) throw new Error('answer pack is truncated');

	// `slice`, not `subarray`: it copies into a fresh ArrayBuffer, which is what
	// `BufferSource` requires (see `fromBase64Url`).
	const iv = combined.slice(0, IV_BYTES);
	const ciphertext = combined.slice(IV_BYTES);

	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

	return JSON.parse(decoder.decode(plaintext)) as RoundPack;
}
