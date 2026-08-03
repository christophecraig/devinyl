import { describe, expect, it } from 'vitest';
import { normalize, normalizeVariants } from './normalize.js';

describe('normalize — step 1: unicode folding', () => {
	it.each([
		['Où sont les femmes', 'ou sont les femmes'],
		['Déjà vu', 'deja vu'],
		['Élégie', 'elegie'],
		['Ça ira', 'ca ira'],
		['Œuvre', 'oeuvre'],
		['Straße', 'strasse'],
		['Encyclopædia', 'encyclopaedia'],
		['Björk', 'bjork']
	])('%s → %s', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});

	it('folds typographic apostrophes to the straight form', () => {
		expect(normalize('L’amour')).toBe(normalize("L'amour"));
	});
});

describe('normalize — step 2: case', () => {
	it('is case-insensitive', () => {
		expect(normalize('ALORS ON DANSE')).toBe(normalize('alors on danse'));
	});
});

describe('normalize — step 3: parentheticals and dash suffixes', () => {
	it.each([
		['Alors on danse (Radio Edit)', 'alors on danse'],
		['Hotel California (Remastered 2011)', 'hotel california'],
		['Wonderwall [Live]', 'wonderwall'],
		['Papaoutai - Radio Edit', 'papaoutai'],
		['Formidable – Live', 'formidable']
	])('%s → %s', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});

	it('keeps hyphenated words intact — the dash must be whitespace-surrounded', () => {
		expect(normalize('Non-stop')).toBe('non stop');
		expect(normalize('Jean-Jacques Goldman')).toBe('jean jacques goldman');
	});

	it('never strips everything away', () => {
		expect(normalize('(Live)')).toBe('live');
		expect(normalize('- Radio Edit')).not.toBe('');
	});
});

describe('normalize — step 4: featuring credits', () => {
	it.each([
		['Djadja feat. Maluma', 'djadja'],
		['Djadja ft. Maluma', 'djadja'],
		['Djadja featuring Maluma', 'djadja'],
		['Djadja (feat. Maluma)', 'djadja'],
		['Basique, avec Damso', 'basique']
	])('%s → %s', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});

	it('does not treat ordinary "avec" or "with" as a credit marker', () => {
		expect(normalize('Avec le temps')).toBe('avec le temps');
		expect(normalize('Seul avec toi')).toBe('seul avec toi');
		expect(normalize('With or Without You')).toBe('with or without you');
	});
});

describe('normalize — step 5: conjunction folding', () => {
	it('folds &, + and et into a single token', () => {
		const forms = [
			'Simon & Garfunkel',
			'Simon and Garfunkel',
			'Simon et Garfunkel',
			'Simon + Garfunkel'
		];
		const normalized = forms.map(normalize);
		expect(new Set(normalized).size).toBe(1);
	});
});

describe('normalize — step 6: punctuation', () => {
	it.each([
		['Where Is My Mind?', 'where is my mind'],
		['Hey, Soul Sister!', 'hey soul sister'],
		['B.O.B', 'b o b'],
		['   spaced    out   ', 'spaced out']
	])('%s → %s', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});
});

describe('normalize — step 7: leading articles', () => {
	it.each([
		['The Beatles', 'beatles'],
		['A Team', 'team'],
		['An Education', 'education'],
		['Le Freak', 'freak'],
		['La Grange', 'grange'],
		['Les Rita Mitsouko', 'rita mitsouko'],
		['Des Visages Des Figures', 'visages des figures'],
		['Du hast', 'hast']
	])('%s → %s', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});

	it('strips at most one leading article', () => {
		expect(normalize('The A Team')).toBe('a team');
	});

	it('never strips an article that is the whole answer', () => {
		expect(normalize('The')).toBe('the');
	});

	it('only strips articles in leading position', () => {
		expect(normalize('Bohemian The Rhapsody')).toBe('bohemian the rhapsody');
	});
});

describe('normalize — step 8: small-number folding', () => {
	it.each([
		['Trois petits cochons', '3 petits cochons'],
		['3 petits cochons', '3 petits cochons'],
		['Three Little Birds', '3 little birds'],
		['Seven Nation Army', '7 nation army'],
		['Sept nation army', '7 nation army'],
		['Ten', '10']
	])('%s → %s', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});

	it('leaves numbers above ten alone', () => {
		expect(normalize('99 Luftballons')).toBe('99 luftballons');
		expect(normalize('Twenty One Pilots')).toBe('twenty 1 pilots');
	});
});

describe('normalize — edge cases', () => {
	it.each([
		['', ''],
		['   ', ''],
		['!!!', '!!!']
	])('%s survives', (input, expected) => {
		expect(normalize(input)).toBe(expected);
	});

	it('is idempotent on already-normalized ASCII', () => {
		const once = normalize('Alors on danse (Radio Edit)');
		expect(normalize(once)).toBe(once);
	});

	it('is deterministic', () => {
		expect(normalize('Où sont les femmes ?')).toBe(normalize('Où sont les femmes ?'));
	});
});

describe('normalizeVariants', () => {
	it('offers both the glued and the elision-dropped reading', () => {
		const variants = normalizeVariants("L'amour est un oiseau rebelle");
		expect(variants).toContain('lamour est 1 oiseau rebelle');
		expect(variants).toContain('amour est 1 oiseau rebelle');
	});

	it('keeps the suffixed reading so typing the printed title also works', () => {
		const variants = normalizeVariants('Alors on danse (Radio Edit)');
		expect(variants).toContain('alors on danse');
		expect(variants).toContain('alors on danse radio edit');
	});

	it('returns an empty list for empty input', () => {
		expect(normalizeVariants('')).toEqual([]);
	});

	it('always includes the canonical form first', () => {
		expect(normalizeVariants('Papaoutai')[0]).toBe(normalize('Papaoutai'));
	});
});
