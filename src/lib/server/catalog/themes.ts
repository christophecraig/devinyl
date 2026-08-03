/**
 * Curated generation themes — CREATE-5, scoped by plan §G-8.
 *
 * The Phase 0 probe measured Deezer's free-text `/search/track` as a
 * general-purpose relevance search, not a theme endpoint: results drift
 * off-topic past the first handful of hits, and 2 of 8 realistic seed phrases
 * returned an unusable pool ("comédie musicale française" 10/25;
 * "génériques dessins animés français" 7/13, with only 13 candidates in the
 * whole catalog). See `docs/catalog-probe-report.md` §5.
 *
 * So v1 ships **no open free-text theme field**. This list is the whole theme
 * surface: the six seeds that cleared the ≥15/25 usable bar in that run,
 * rendered to the player as choices. The client sends a `key`; the query string
 * never comes from the player.
 *
 * Adding a theme means probing it first and recording the result — a theme that
 * yields a thin or off-topic pool produces a quiz whose songs nobody
 * recognises, which is precisely the failure mode the probe existed to catch.
 */

export interface CuratedTheme {
	/** Stable key — this is what crosses the wire, never the query. */
	key: string;
	/** The vetted provider query. */
	query: string;
	labelFr: string;
	labelEn: string;
	/** Usable-result ratio measured by the Phase 0 probe, kept so re-probes are comparable. */
	probedUsable: string;
}

export const CURATED_THEMES: readonly CuratedTheme[] = [
	{
		key: 'chanson-amour',
		query: "chanson d'amour française",
		labelFr: "Chansons d'amour",
		labelEn: 'Love songs',
		probedUsable: '24/25'
	},
	{
		key: 'chanson-francaise',
		query: 'chanson française',
		labelFr: 'Chanson française',
		labelEn: 'French chanson',
		probedUsable: '23/25'
	},
	{
		key: 'bo-film',
		query: 'bande originale de film',
		labelFr: 'Bandes originales de film',
		labelEn: 'Movie soundtracks',
		probedUsable: '21/25'
	},
	{
		key: 'annees-80',
		query: 'années 80',
		labelFr: 'Années 80',
		labelEn: 'The 80s',
		probedUsable: '19/25'
	},
	{
		key: 'rap-francais',
		query: 'rap français',
		labelFr: 'Rap français',
		labelEn: 'French rap',
		probedUsable: '18/25'
	},
	{
		key: 'noel',
		query: 'musique de Noël',
		labelFr: 'Musique de Noël',
		labelEn: 'Christmas music',
		probedUsable: '17/25'
	}
];

const BY_KEY = new Map(CURATED_THEMES.map((t) => [t.key, t]));

/** `null` for anything not on the list — an unknown key is a 400, never a raw search. */
export function themeByKey(key: string): CuratedTheme | null {
	return BY_KEY.get(key) ?? null;
}
