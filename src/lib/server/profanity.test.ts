import { describe, expect, it } from 'vitest';
import { isBlockedName, nameRejectionMessage } from './profanity.js';

/**
 * The false-positive cases below are the permanent regression tests
 * `profanity/README.md` asks for by name. They matter more than the true
 * positives: a missed slur is a moderation gap, a false positive is a real
 * person locked out of the board by their own name.
 */
describe('isBlockedName — false positives (README regression set)', () => {
	it.each([
		['Scunthorpe', 'cunt'],
		['Penistone', 'penis'],
		['Lightwater', 'twat'],
		['Twatt', 'twat'],
		['niggardly', 'nigga'],
		['shiitake', 'shit']
	])('allows %s despite containing the stem %s', (name) => {
		expect(isBlockedName(name)).toBe(false);
	});

	it.each([
		'Concert',
		'Second',
		'Balcon',
		'Raconter',
		'Calcul',
		'Ridicule',
		'Dispute',
		'Unique',
		'Technique',
		'Orbite',
		'Sussex',
		'Classe',
		'Assassin',
		'Document',
		'Titan',
		'Michelle',
		'Journal',
		'Analyse',
		'Inculte',
		'Inculper'
	])('allows the ordinary word %s', (name) => {
		expect(isBlockedName(name)).toBe(false);
	});

	it.each([
		'Zaz',
		'Angèle',
		'Orelsan',
		'Aya Nakamura',
		'Jean-Jacques',
		"L'Ami D. Pierre",
		'Mc Solaar'
	])('allows the ordinary nickname %s', (name) => {
		expect(isBlockedName(name)).toBe(false);
	});
});

describe('isBlockedName — true positives', () => {
	it('blocks an exact whole-token entry', () => {
		expect(isBlockedName('connard')).toBe(true);
	});

	it('blocks an exact entry appearing as one token among several', () => {
		expect(isBlockedName('Le Connard Masqué')).toBe(true);
	});

	it('blocks a multi-word phrase entry after normalization collapses the separators', () => {
		expect(isBlockedName('Fils   de-Pute!')).toBe(true);
	});

	it('blocks a substring stem embedded in an evasion', () => {
		expect(isBlockedName('xXfuckXx')).toBe(true);
	});

	it('matches through accents and case, since matching runs on the normalized form', () => {
		expect(isBlockedName('ENCULÉ')).toBe(true);
	});

	it('blocks a listed leetspeak variant', () => {
		// Normalization folds accents but deliberately not digits — variants are
		// their own list entries (profanity/README.md, "Adding entries").
		expect(isBlockedName('n1gger')).toBe(true);
	});

	it('checks both language lists regardless of the player locale', () => {
		expect(isBlockedName('bitch')).toBe(true);
		expect(isBlockedName('salope')).toBe(true);
	});
});

describe('allowlist precedence', () => {
	it('strips the allowlisted span but still checks the rest of the name', () => {
		// The README is explicit that an allowlist hit must not bail out of the
		// whole check — only the allowlisted span is exempt.
		expect(isBlockedName('Scunthorpe')).toBe(false);
		expect(isBlockedName('Scunthorpe fuck')).toBe(true);
	});
});

describe('edge cases', () => {
	it('does not block a name that normalizes to nothing', () => {
		expect(isBlockedName('!!!')).toBe(false);
	});

	it('does not block an empty name — length is the schema’s job, not the filter’s', () => {
		expect(isBlockedName('')).toBe(false);
	});
});

describe('nameRejectionMessage', () => {
	it('never names what matched', () => {
		for (const locale of ['fr', 'en'] as const) {
			const message = nameRejectionMessage(locale);
			expect(message).not.toMatch(/connard|fuck|bitch/i);
			expect(message.length).toBeGreaterThan(0);
		}
	});

	it('is localized', () => {
		expect(nameRejectionMessage('fr')).not.toBe(nameRejectionMessage('en'));
	});
});
