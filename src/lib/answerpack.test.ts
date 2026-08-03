import { describe, expect, it } from 'vitest';
import {
	deriveRoundKey,
	fromBase64Url,
	generateSessionSeed,
	openRoundPack,
	sealRoundPack,
	toBase64Url
} from './answerpack.js';
import type { RoundPack } from './game/types.js';

const pack: RoundPack = {
	answers: { title: ['alors on danse'], artist: ['stromae'] },
	reveal: {
		title: 'Alors on danse',
		artists: ['Stromae'],
		albumTitle: 'Cheese',
		coverUrl: 'https://cdn.example/cover.jpg',
		releaseYear: 2009
	}
};

describe('base64url', () => {
	it('round-trips arbitrary bytes', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(64));
		expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
	});

	it('emits no padding or URL-hostile characters', () => {
		const encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(30)));
		expect(encoded).not.toMatch(/[+/=]/);
	});

	it('round-trips every length across a padding cycle', () => {
		for (let n = 0; n <= 8; n++) {
			const bytes = crypto.getRandomValues(new Uint8Array(n));
			expect(fromBase64Url(toBase64Url(bytes)), `length ${n}`).toEqual(bytes);
		}
	});
});

describe('generateSessionSeed', () => {
	it('produces a fresh seed each time', () => {
		const seeds = new Set(Array.from({ length: 50 }, generateSessionSeed));
		expect(seeds.size).toBe(50);
	});

	it('carries 32 bytes of entropy', () => {
		expect(fromBase64Url(generateSessionSeed())).toHaveLength(32);
	});
});

describe('deriveRoundKey — §7.2', () => {
	it('derives deterministically, so client and server agree', async () => {
		const seed = generateSessionSeed();
		const a = await deriveRoundKey(seed, 3);
		const b = await deriveRoundKey(seed, 3);
		// CryptoKeys are opaque; prove equality through the ciphertext they open.
		const sealed = await sealRoundPack(seed, 3, pack);
		await expect(openRoundPack(seed, 3, sealed)).resolves.toEqual(pack);
		expect(a.algorithm).toEqual(b.algorithm);
	});

	it('gives each round a different key', async () => {
		const seed = generateSessionSeed();
		const sealed = await sealRoundPack(seed, 0, pack);
		// Round 1's key must not open round 0's pack.
		await expect(openRoundPack(seed, 1, sealed)).rejects.toThrow();
	});

	it('gives each session a different key', async () => {
		const sealed = await sealRoundPack(generateSessionSeed(), 0, pack);
		await expect(openRoundPack(generateSessionSeed(), 0, sealed)).rejects.toThrow();
	});
});

describe('sealRoundPack / openRoundPack', () => {
	it('round-trips a pack intact', async () => {
		const seed = generateSessionSeed();
		const sealed = await sealRoundPack(seed, 7, pack);
		expect(await openRoundPack(seed, 7, sealed)).toEqual(pack);
	});

	it('leaks no answer text into the sealed blob (MUS-4)', async () => {
		const seed = generateSessionSeed();
		const sealed = await sealRoundPack(seed, 0, pack);
		for (const secret of ['alors', 'danse', 'stromae', 'Cheese', 'Alors on danse']) {
			expect(sealed.toLowerCase()).not.toContain(secret.toLowerCase());
		}
	});

	it('produces a different blob each time for the same input (fresh IV)', async () => {
		const seed = generateSessionSeed();
		const a = await sealRoundPack(seed, 0, pack);
		const b = await sealRoundPack(seed, 0, pack);
		expect(a).not.toBe(b);
		expect(await openRoundPack(seed, 0, b)).toEqual(pack);
	});

	it('rejects a tampered blob rather than yielding garbage (AES-GCM authenticates)', async () => {
		const seed = generateSessionSeed();
		const sealed = await sealRoundPack(seed, 0, pack);
		const bytes = fromBase64Url(sealed);
		bytes[bytes.length - 1] ^= 0xff;
		await expect(openRoundPack(seed, 0, toBase64Url(bytes))).rejects.toThrow();
	});

	it('rejects a truncated blob with a clear error', async () => {
		const seed = generateSessionSeed();
		await expect(openRoundPack(seed, 0, toBase64Url(new Uint8Array(4)))).rejects.toThrow(
			/truncated/
		);
	});

	it('works across the full round range of a 50-round quiz', async () => {
		const seed = generateSessionSeed();
		for (const position of [0, 1, 24, 49]) {
			const sealed = await sealRoundPack(seed, position, pack);
			expect(await openRoundPack(seed, position, sealed), `round ${position}`).toEqual(pack);
		}
	});
});
