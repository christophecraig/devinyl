/**
 * Answer normalization — technical-spec §8.1 (ANS-2).
 *
 * Pure and isomorphic: runs on the client for instant feedback (§7.2) and on
 * the server as the authority (§7.3). Must never import server or browser APIs.
 *
 * The pipeline is applied identically to *accepted answers* (precomputed once at
 * quiz assembly, §5.4) and to *player input* (on every submit). Symmetry is the
 * whole point: any transformation applied to one side is applied to the other,
 * so folding is safe even when it is lossy.
 */

/** Words that may be dropped when they lead an answer (step 7). */
const LEADING_ARTICLES = new Set([
	// English
	'the',
	'a',
	'an',
	// French
	'le',
	'la',
	'les',
	'l',
	'un',
	'une',
	'des',
	'du',
	'de',
	'd'
]);

/**
 * Single letters that elide with an apostrophe in French (`l'amour`, `n'existe`).
 * Used to produce the elision-dropped variant.
 */
const ELIDABLE = new Set(['l', 'd', 'j', 'n', 'qu', 's', 'c', 't', 'm']);

/**
 * Digit ↔ word folding for 1–10 (step 8). Everything folds *to the digit*, so
 * "3 petits cochons" and "trois petits cochons" reach the same canonical form.
 */
const NUMBER_WORDS: Record<string, string> = {
	one: '1',
	un: '1',
	une: '1',
	two: '2',
	deux: '2',
	three: '3',
	trois: '3',
	four: '4',
	quatre: '4',
	five: '5',
	cinq: '5',
	six: '6',
	seven: '7',
	sept: '7',
	eight: '8',
	huit: '8',
	nine: '9',
	neuf: '9',
	ten: '10',
	dix: '10'
};

/**
 * Conjunctions that fold together (step 5). `&`, `+`, `and` and `et` all become
 * the single token `and` — again symmetric, so a player typing "et" matches a
 * title printed with "&".
 */
const CONJUNCTIONS = new Set(['and', 'et']);

/** Credit markers that are stripped unconditionally along with everything after them. */
const HARD_FEAT_MARKERS = /\s(?:feat|ft|featuring|feats)\b[\s.].*$/i;

/**
 * `avec` and `with` are ordinary words ("Seul avec toi", "With or Without You"),
 * so they only read as credit markers when a comma introduces them.
 */
const SOFT_FEAT_MARKERS = /,\s*(?:avec|with)\b.*$/i;

/** `(Remastered 2011)`, `[Live]`, `{Radio Edit}` — anywhere in the string. */
const BRACKETED = /[([{][^)\]}]*[)\]}]/g;

/**
 * A trailing ` - Radio Edit`. The dash must be whitespace-surrounded so hyphenated
 * words ("Non-stop", "Jean-Jacques") survive.
 */
const DASH_SUFFIX = /\s[-–—]\s.*$/;

/** Keep a transformation only when it leaves something behind. */
function guard(next: string, previous: string): string {
	const trimmed = next.trim();
	return trimmed.length > 0 ? trimmed : previous;
}

/**
 * Steps 1–2: Unicode fold. NFKD decomposition strips combining marks (accents),
 * with explicit handling for ligatures that do not decompose.
 */
function foldUnicode(input: string): string {
	return input
		.replace(/ß/g, 'ss')
		.replace(/œ/g, 'oe')
		.replace(/Œ/g, 'OE')
		.replace(/æ/g, 'ae')
		.replace(/Æ/g, 'AE')
		.replace(/ø/g, 'o')
		.replace(/Ø/g, 'O')
		.replace(/ł/g, 'l')
		.replace(/Ł/g, 'L')
		.replace(/[‘’ʼ′`´]/g, "'")
		.replace(/[“”]/g, '"')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

/** Step 3: parentheticals and trailing dash-suffixes. */
function stripSuffixes(input: string): string {
	let out = guard(input.replace(BRACKETED, ' '), input);
	out = guard(out.replace(DASH_SUFFIX, ''), out);
	return out;
}

/** Step 4: featuring credits. */
function stripFeaturing(input: string): string {
	let out = guard(input.replace(SOFT_FEAT_MARKERS, ''), input);
	out = guard(out.replace(HARD_FEAT_MARKERS, ''), out);
	return out;
}

/**
 * Steps 5–6: conjunction symbols, then all remaining punctuation. Apostrophes are
 * removed rather than spaced, so `l'amour` glues to `lamour`; the elision-dropped
 * reading (`amour`) is produced separately as a variant.
 */
function stripPunctuation(input: string): string {
	const out = input
		.replace(/&/g, ' and ')
		.replace(/\+/g, ' and ')
		.replace(/['’]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return guard(out, input);
}

/** Steps 5, 7 and 8 operate on tokens. */
function foldTokens(input: string): string {
	let tokens = input.split(' ').filter(Boolean);
	if (tokens.length === 0) return input;

	// Step 7 — leading articles. Only one is stripped: "the a team" is a title,
	// not two stacked articles.
	if (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0])) {
		tokens = tokens.slice(1);
	}

	tokens = tokens.map((token) => {
		// Step 5 — conjunction folding.
		if (CONJUNCTIONS.has(token)) return 'and';
		// Step 8 — small-number folding.
		return NUMBER_WORDS[token] ?? token;
	});

	return tokens.join(' ');
}

/**
 * The canonical normalized form of a title or artist name.
 *
 * Returns an empty string only for input that is empty or punctuation-only.
 */
export function normalize(input: string): string {
	if (typeof input !== 'string') return '';
	let out = input.trim();
	if (out.length === 0) return '';

	out = foldUnicode(out);
	out = stripSuffixes(out);
	out = stripFeaturing(out);
	out = stripPunctuation(out);
	out = foldTokens(out);

	return out;
}

/**
 * The elision-dropped reading of an apostrophised French phrase: `l'amour` also
 * reads as `amour`. Returns `null` when the input contains no elision.
 *
 * This exists because step 6 glues apostrophes shut, and a player who types
 * `lamour` should reach the same place as one who types `l'amour`. Damerau-
 * Levenshtein would usually rescue the one-character difference, but not on
 * short answers where the threshold is 0.
 */
function elisionDropped(input: string): string | null {
	const folded = foldUnicode(input);
	if (!folded.includes("'")) return null;

	const dropped = folded.replace(/\b([a-z]{1,2})'/g, (whole, prefix: string) =>
		ELIDABLE.has(prefix) ? '' : whole
	);
	if (dropped === folded) return null;

	const result = normalize(dropped);
	return result.length > 0 ? result : null;
}

/**
 * Every accepted normalized form of a single raw string.
 *
 * Used on both sides of a match: accepted answers are expanded once at assembly
 * (§5.4) and player input is expanded on submit, then every input form is tried
 * against every accepted form.
 */
export function normalizeVariants(input: string): string[] {
	const canonical = normalize(input);
	if (canonical.length === 0) return [];

	const variants = new Set<string>([canonical]);

	const elided = elisionDropped(input);
	if (elided) variants.add(elided);

	// A player may legitimately type the full title including the suffix that
	// step 3 strips, so the unstripped reading is accepted too.
	const withSuffixes = foldTokens(stripPunctuation(foldUnicode(input)));
	if (withSuffixes.length > 0) variants.add(withSuffixes);

	return [...variants];
}
