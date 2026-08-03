import { describe, expect, it } from 'vitest';
import { buildAnswerKey, damerauLevenshtein, match, maxDistanceFor } from './match.js';
import { normalize } from './normalize.js';

describe('damerauLevenshtein', () => {
	it.each([
		['', '', 0],
		['a', '', 1],
		['', 'abc', 3],
		['kitten', 'sitting', 3],
		['stromae', 'stromae', 0],
		['stromae', 'stromea', 1], // transposition counts as one
		['stromae', 'stromaee', 1],
		['stromae', 'stroma', 1],
		['ca', 'abc', 3]
	])('d(%s, %s) = %i', (a, b, expected) => {
		expect(damerauLevenshtein(a, b)).toBe(expected);
	});

	it('is symmetric', () => {
		expect(damerauLevenshtein('brassens', 'brassen')).toBe(
			damerauLevenshtein('brassen', 'brassens')
		);
	});

	it('short-circuits above maxDistance without lying about ordering', () => {
		const capped = damerauLevenshtein('completely different', 'nothing alike', 2);
		expect(capped).toBeGreaterThan(2);
	});

	it('returns the true distance when it is within maxDistance', () => {
		expect(damerauLevenshtein('stromae', 'stromea', 3)).toBe(1);
	});
});

describe('maxDistanceFor — technical-spec §8.2 thresholds', () => {
	it.each([
		[1, 0],
		[3, 0],
		[4, 1],
		[6, 1],
		[7, 2],
		[10, 2],
		[11, 3],
		[40, 3]
	])('length %i → max distance %i', (length, expected) => {
		expect(maxDistanceFor(length)).toBe(expected);
	});
});

describe('match — boundary behaviour at each threshold', () => {
	it('accepts nothing but an exact match on very short answers (1–3)', () => {
		expect(match('sia', ['sia'])).toBe(true);
		expect(match('sio', ['sia'])).toBe(false);
	});

	it('tolerates exactly one edit at length 4–6 and no more', () => {
		expect(match('orelsa', ['orelsan'])).toBe(true); // distance 1
		expect(match('orels', ['orelsan'])).toBe(false); // distance 2 over a 5-char input
		expect(match('brel', ['brel'])).toBe(true);
		expect(match('brol', ['brel'])).toBe(true); // distance 1
		expect(match('brok', ['brel'])).toBe(false); // distance 2 over a 4-char key
	});

	it('tolerates two edits at length 7–10', () => {
		expect(match('stromae', ['stromae'])).toBe(true);
		expect(match('stromea', ['stromae'])).toBe(true);
		expect(match('stromaee', ['stromae'])).toBe(true);
		expect(match('strxmxe', ['stromae'])).toBe(true); // distance 2
		expect(match('strxmxx', ['stromae'])).toBe(false); // distance 3
	});

	it('tolerates three edits at length ≥ 11', () => {
		const key = [normalize('Bigflo & Oli')];
		expect(match('bigflo and oli', key)).toBe(true);
		expect(match('bigflo et oli', key)).toBe(true);
		expect(match('bigflow and olli', key)).toBe(true);
	});
});

describe('match — forgiveness required by ANS-2', () => {
	const key = buildAnswerKey({
		title: 'Alors on danse (Radio Edit)',
		titleShort: 'Alors on danse',
		artists: [{ name: 'Stromae', primary: true }]
	});

	it.each([
		'alors on danse',
		'Alors On Danse',
		'ALORS ON DANSE!',
		'alors on dance',
		'alors on danse (radio edit)',
		'  alors on danse  '
	])('accepts %s', (input) => {
		expect(match(input, key.title)).toBe(true);
	});

	it.each(['formidable', 'papaoutai', 'ta fete', ''])('rejects %s', (input) => {
		expect(match(input, key.title)).toBe(false);
	});

	it('never matches against an empty answer key', () => {
		expect(match('anything', [])).toBe(false);
	});
});

describe('match — accents, articles and elision', () => {
	it('accepts a missing accent', () => {
		const key = buildAnswerKey({
			title: 'Déjà vu',
			titleShort: 'Déjà vu',
			artists: [{ name: 'X', primary: true }]
		});
		expect(match('deja vu', key.title)).toBe(true);
	});

	it('accepts a title with or without its leading article', () => {
		const key = buildAnswerKey({
			title: 'La Grange',
			titleShort: 'La Grange',
			artists: [{ name: 'ZZ Top', primary: true }]
		});
		expect(match('la grange', key.title)).toBe(true);
		expect(match('grange', key.title)).toBe(true);
	});

	it('accepts an elided title typed with or without the apostrophe', () => {
		const key = buildAnswerKey({
			title: "L'amour est un oiseau rebelle",
			titleShort: "L'amour est un oiseau rebelle",
			artists: [{ name: 'X', primary: true }]
		});
		for (const input of [
			"l'amour est un oiseau rebelle",
			'lamour est un oiseau rebelle',
			'amour est un oiseau rebelle'
		]) {
			expect(match(input, key.title), input).toBe(true);
		}
	});
});

describe('buildAnswerKey — §5.4 / ANS-3', () => {
	const key = buildAnswerKey({
		title: 'Djadja (feat. Maluma)',
		titleShort: 'Djadja',
		artists: [
			{ name: 'Aya Nakamura', primary: true },
			{ name: 'Maluma', primary: false }
		]
	});

	it('accepts the primary artist', () => {
		expect(match('aya nakamura', key.artist)).toBe(true);
	});

	it('accepts a featured artist too, without requiring them', () => {
		expect(match('maluma', key.artist)).toBe(true);
	});

	it('rejects an unrelated artist', () => {
		expect(match('orelsan', key.artist)).toBe(false);
	});

	it('strips the featuring credit from the title key', () => {
		expect(match('djadja', key.title)).toBe(true);
	});

	it('deduplicates identical normalized forms', () => {
		const duplicated = buildAnswerKey({
			title: 'Papaoutai',
			titleShort: 'Papaoutai',
			artists: [
				{ name: 'Stromae', primary: true },
				{ name: 'STROMAE', primary: false }
			]
		});
		expect(duplicated.artist).toEqual(['stromae']);
	});

	it('survives a missing titleShort', () => {
		const key = buildAnswerKey({
			title: 'Formidable',
			titleShort: null,
			artists: [{ name: 'Stromae', primary: true }]
		});
		expect(match('formidable', key.title)).toBe(true);
	});
});

describe('match — short answers do not borrow a longer answer’s tolerance', () => {
	// Regression: the property run against the real probe corpus caught "Air"
	// matching the artist "Amir". Scaling the threshold on the accepted form
	// alone let a 3-char input ride a 4-char answer's distance-1 budget.
	it('rejects Air as Amir, and Amir as Air', () => {
		expect(match('air', ['amir'])).toBe(false);
		expect(match('amir', ['air'])).toBe(false);
	});

	it.each([
		['sia', 'siam'],
		['ete', 'etre'],
		['jul', 'juls']
	])('rejects %s as %s', (input, accepted) => {
		expect(match(input, [accepted])).toBe(false);
	});

	it('still forgives a real typo on a long answer', () => {
		expect(match('aya nakamoura', ['aya nakamura'])).toBe(true);
		expect(match('jean jaques goldman', ['jean jacques goldman'])).toBe(true);
	});
});

describe('match — ANS-5: no information leaks through the API', () => {
	it('returns a plain boolean and nothing else', () => {
		expect(typeof match('stromae', ['stromae'])).toBe('boolean');
		expect(typeof match('wrong', ['stromae'])).toBe('boolean');
	});
});
