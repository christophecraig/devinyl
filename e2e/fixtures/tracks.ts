/**
 * Track fixtures for the solo-play e2e suite (plan task 1.30).
 *
 * Ten French-repertoire tracks (real songs/artists — only the *audio* is
 * synthesized, per e2e/fixtures/README.md; titles/artists are plain public
 * facts, not copyrighted content). `clipFile` points at one of the
 * already-committed tone WAVs (task 1.29) — which tone plays for which round
 * is arbitrary, it only needs to be *a* decodable clip.
 *
 * Titles/artists are deliberately >= 4 normalized characters wherever a test
 * needs a typo'd guess for that field: `maxDistanceFor()` in
 * `src/lib/game/match.ts` grants zero tolerance at length <= 3, so a 3-char
 * answer (e.g. "Zaz") cannot take a typo and still match — those fields are
 * called out below and the happy-path test types them exactly.
 */

export interface FixtureArtist {
	name: string;
	primary: boolean;
}

export interface FixtureTrack {
	title: string;
	artists: FixtureArtist[];
	albumTitle: string;
	coverUrl: string | null;
	releaseYear: number | null;
	/** Filename under e2e/fixtures/ (task 1.29's synthesized tones). */
	clipFile: string;
}

const TONES = ['tone-a-440hz-30s.wav', 'tone-b-880hz-30s.wav', 'tone-c-220hz-30s.wav'] as const;

/** Cycles through the three long tones — round-to-round clip identity doesn't matter, only decodability does. */
function toneFor(index: number): string {
	return TONES[index % TONES.length];
}

/**
 * Ten rounds for the happy-path / keyboard-only / axe tests. `artists[0].name`
 * "Zaz" (3 normalized chars) is the one deliberately untypo'able field in this
 * set — see module doc.
 */
export const SOLO_QUIZ_TRACKS: FixtureTrack[] = [
	{
		title: 'Formidable',
		artists: [{ name: 'Stromae', primary: true }],
		albumTitle: 'Racine carrée',
		coverUrl: null,
		releaseYear: 2013,
		clipFile: toneFor(0)
	},
	{
		title: 'Papaoutai',
		artists: [{ name: 'Stromae', primary: true }],
		albumTitle: 'Racine carrée',
		coverUrl: null,
		releaseYear: 2013,
		clipFile: toneFor(1)
	},
	{
		title: 'Dernière Danse',
		artists: [{ name: 'Indila', primary: true }],
		albumTitle: 'Mini World',
		coverUrl: null,
		releaseYear: 2014,
		clipFile: toneFor(2)
	},
	{
		title: 'Je Veux',
		artists: [{ name: 'Zaz', primary: true }],
		albumTitle: 'Zaz',
		coverUrl: null,
		releaseYear: 2010,
		clipFile: toneFor(0)
	},
	{
		title: 'La Vie En Rose',
		artists: [{ name: 'Édith Piaf', primary: true }],
		albumTitle: 'La Vie En Rose',
		coverUrl: null,
		releaseYear: 1947,
		clipFile: toneFor(1)
	},
	{
		title: 'Ne Me Quitte Pas',
		artists: [{ name: 'Jacques Brel', primary: true }],
		albumTitle: 'La Valse à Mille Temps',
		coverUrl: null,
		releaseYear: 1959,
		clipFile: toneFor(2)
	},
	{
		title: 'Comme Des Enfants',
		artists: [{ name: 'Cœur de Pirate', primary: true }],
		albumTitle: 'Cœur de Pirate',
		coverUrl: null,
		releaseYear: 2008,
		clipFile: toneFor(0)
	},
	{
		title: 'On Écrit Sur Les Murs',
		artists: [
			{ name: 'Kids United', primary: true },
			{ name: 'Black M', primary: false }
		],
		albumTitle: 'Un Monde Meilleur',
		coverUrl: null,
		releaseYear: 2015,
		clipFile: toneFor(1)
	},
	{
		title: 'Alors On Danse',
		artists: [{ name: 'Stromae', primary: true }],
		albumTitle: 'Cheese',
		coverUrl: null,
		releaseYear: 2009,
		clipFile: toneFor(2)
	},
	{
		title: 'Game Over',
		artists: [{ name: 'Vitaa', primary: true }],
		albumTitle: 'Idéal',
		coverUrl: null,
		releaseYear: 2011,
		clipFile: toneFor(0)
	}
];

/** Short deck for tests that don't need the full ten (axe gate, live-region ordering). */
export const SHORT_QUIZ_TRACKS: FixtureTrack[] = SOLO_QUIZ_TRACKS.slice(0, 4);

/**
 * Four tracks with **distinct primary artists** (unlike `SHORT_QUIZ_TRACKS`,
 * whose first two both credit Stromae) — the choice-mode test needs
 * `choicesFromDeck` to always be able to build 4 distinct artist options
 * (ANS-6), which a repeated artist name would collapse to 3.
 */
export const CHOICE_QUIZ_TRACKS: FixtureTrack[] = [
	SOLO_QUIZ_TRACKS[0], // Formidable / Stromae
	SOLO_QUIZ_TRACKS[2], // Dernière Danse / Indila
	SOLO_QUIZ_TRACKS[3], // Je Veux / Zaz
	SOLO_QUIZ_TRACKS[4] // La Vie En Rose / Édith Piaf
];

/**
 * A single round whose clip is the deliberately-short 5s tone (task 1.29) —
 * used by the live-region-ordering test, which needs to let a clip run to its
 * natural end without the wait dominating the test.
 */
export const SHORT_CLIP_TRACK: FixtureTrack = {
	...SOLO_QUIZ_TRACKS[0],
	clipFile: 'tone-short-660hz-5s.wav'
};
