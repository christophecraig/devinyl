# Profanity blocklists (FAIR-5)

`fr.json` and `en.json` back the name filter described in technical-spec §11
("Profanity filter, FAIR-5"). This directory holds **data only** — no
matcher code lives here; whatever module implements `checkName()` /
`isBlocked()` reads these two files.

## File format

```jsonc
{
	"$comment": "…",
	"exact": ["…"], // whole-token (or whole-phrase) match only
	"substring": ["…"], // matched anywhere in the normalized string
	"allowlist": ["…"] // legitimate words that must win over a substring hit
}
```

## Entries are pre-normalized

The matcher runs against the **normalized form** of a name, using the exact
pipeline in technical-spec §8.1: Unicode NFKD → strip accents → lowercase →
strip punctuation/apostrophes → collapse whitespace. So every entry in these
files must already be written in that form:

- lowercase, ASCII only, no accents (`enculé` → `encule`)
- no punctuation, no apostrophes
- single-word entries have no internal spaces
- phrase entries (e.g. `"fils de pute"`) are written as space-separated
  words — normalization _collapses_ whitespace, it doesn't remove it, so a
  phrase entry still matches after a name like `Fils   de-Pute!` normalizes
  down to `fils de pute`.

If you ever add an entry with an accent, a capital letter, or stray
punctuation, it will silently never match anything. There is no
normalization applied to the list itself at load time — what's in the file
is compared byte-for-byte against the normalized name.

## `exact` vs `substring` — and why almost everything is `exact`

**`exact`** matches a whole normalized token. It can never produce a
Scunthorpe-style false positive, because it requires the _entire_ word (or
phrase) to equal the banned entry — a longer word that happens to contain
the banned stem doesn't match.

**`substring`** matches the banned stem anywhere inside the normalized
name. This is strictly more powerful — it catches evasions like
`xXfuckXx`, `bigcuntenergy`, `urabitch` — but it is also how blocklists
produce their most embarrassing failures. The canonical case is
**Scunthorpe**: a UK town whose name contains `cunt`, whose residents have
had genuine trouble registering email addresses and forum accounts for
decades because someone put `cunt` in a substring list without checking
what else contains it. The same class of bug hits **Penistone** (`penis`)
and **Lightwater** (`twat`).

**Rule applied throughout this file:** a stem goes into `substring` only if
it has **no known legitimate host word or name at all**. The moment a stem
has _any_ common legitimate host, it goes into `exact` instead, full stop —
even though that means the matcher will occasionally miss a `[stem]-plus-
garbage-characters` evasion. A missed evasion is a minor moderation gap; a
false positive is a real person locked out of a public leaderboard by their
own name or nickname.

This is why the required "gotcha" stems from the task brief are **not**
in `substring` here:

- French `con` — hosts: `concert`, `contre`, `connaitre`, `second`, `bacon`,
  `flacon`, `balcon`, `icone`, `raconter`, `conseil`, `content`,
  `confiture`, `concours`, `contact`, `condor`, `falcon`, `deconne`.
  → kept as `exact` (`con`, `conne`), plus the specific vulgar derivatives
  (`connard`, `connasse`, …) as their own `exact` entries.
- French `cul` — hosts: `calcul`, `ridicule`, `particule`, `matricule`,
  `curcuma`, `reculer`, `cultiver`, `culture`, `articule`, `vehicule`,
  `minuscule`, `majuscule`, `spectaculaire`. → `exact` only.
- French `pute` — hosts: `dispute`, `reputation`, `amputer`, `computer`,
  `imputer`. → `exact` only.
- French `bite` — hosts: `arbiter`, `orbite`, `habite`, `cohabite`. →
  `exact` only.
- French `nique` — hosts: `unique`, `technique`, `clinique`, `panique`,
  `musique`. This one is severe (`nique` bare would flag half the French
  vocabulary) → `exact` only.
- French `sexe` / English `sex` — hosts: `sussex`, `essex`, `middlesex`,
  `sextet`. → `exact` only, and `sex` isn't even listed bare in `en.json`
  because it's rarely the _whole_ vulgar token on its own; the explicit
  compounds are listed instead.
- English `ass` — hosts: `class`, `bass`, `pass`, `assassin`, `massive`,
  `glass`, `grass`, `compass`, `embassy`, `assist`, `assume`. → `exact`
  only (`asshole`, `jackass`, `dumbass` as their own whole-word entries).
- English `hell` and `anal` — both have big host lists (`shell`, `hello`,
  `michelle`, `othello`; `analog`, `analyse`, `banal`, `canal`, `journal`).
  `hell` isn't blocked at all (it's mild and outside the required
  categories); `anal` is blocked but `exact` only.
- English `cum` — hosts: `cucumber`, `document`, `circumstance`,
  `accumulate`. → `exact` only.
- English `tit` — hosts: `title`, `titan`, `constitution`, `petit`,
  `attitude`, `competitive`. → `exact` only (and not even listed bare;
  no clean unambiguous whole-word form was worth the risk).

### What _did_ go into `substring`, and why it's safe

A handful of stems have no plausible legitimate host and are listed as
`substring` to catch concatenated evasions:

- `fr.json`: `encul`, `bougnoul`, `chinetoqu`, `niakoue`, `crouill`,
  `tarlouz`, `tantouz`, `youpin`. Checked against common French vocabulary
  for accidental hosts (e.g. `encul` does **not** match `inculte` /
  `inculper` / `inculquer` — those contain `incul`, not `encul`, a
  different preceding vowel). No allowlist entries were needed for French
  because these stems were chosen specifically to have zero known
  collisions — if you add a new French substring entry, you must do the
  same check before skipping the allowlist.
- `en.json`: `fuck`, `shit`, `bitch`, `nigger`, `nigga`, `cunt`, `penis`,
  `twat`. The last three are the deliberately-risky ones from the task
  brief — kept in `substring` (rather than punted to `exact`) specifically
  to demonstrate the allowlist mechanism, since evasion-catching power on
  these particular words is worth the trade-off _once the known hosts are
  allowlisted_:
  - `cunt` → `scunthorpe`
  - `penis` → `penistone`
  - `twat` → `lightwater`, `twatt` (a real place name in Orkney)
  - `nigga` → `niggardly`, `niggard` — a real, unrelated English word
    ("stingy") that is etymologically unconnected to the slur but is a
    well-documented real-world false-positive trigger (it has gotten
    people fired and banned for using it correctly). This is arguably the
    single most important allowlist entry in this file.
  - `shit` → `shiitake` (checked: not an actual character-for-character
    collision — `shiitake` has a double `i` before the `t` — but kept as a
    documented near-miss so a future editor doesn't have to re-derive it).

**If you add a new `substring` entry, you must add this same analysis** —
either "checked, no known host, none needed" or a concrete allowlist entry
per host found. Do not add a stem to `substring` without doing this check.

### Known, accepted trade-offs on `exact` entries

`exact` match is not risk-free either — it just fails differently. An
`exact` entry can still collide with a real word if a name legitimately
consists of _only_ that word:

- French `pedale` is blocked (dominant modern usage is the homophobic
  slur) even though it's also the ordinary word for a bicycle pedal.
- French `macaque` and `raton` are blocked (racial slurs) even though
  they're also literal animal names (macaque monkey; `raton laveur` =
  raccoon — note `raton` alone as a phrase-adjacent token would flag
  `raton laveur` too, a known limitation of whole-token matching without
  phrase-awareness).
- English `fag` is blocked (homophobic slur) even though it's common
  British slang for a cigarette.

These were judged acceptable because the _context_ is a public nickname —
nobody registers "pedale" because they cycle, or "raton" because they like
raccoons — unlike Scunthorpe/Penistone, which are pre-existing place names
and surnames people don't choose but are stuck with. We deliberately did
**not** block French `mongol`/`mongole` (ableist slur) bare, because it's
also the demonym for Mongolia/Mongolian people — used `mongolien` /
`mongolienne` instead, which carries the slur sense without the country
collision. We also skipped `retard` in French entirely (it's the ordinary
word for "delay/late", used constantly — `en retard`) despite including
`retard`/`retarded` in English, where it isn't part of everyday
vocabulary.

## Allowlist precedence

The matcher must check `allowlist` **before** rejecting on a `substring`
hit: if the normalized name contains an allowlisted string, that match
wins and the name is accepted, even if it also contains a `substring`
entry. (`allowlist` is not relevant to `exact` matches — those already
can't false-positive the way substring can.) Implementation sketch:

```
normalized = normalize(name)
if normalized is in exact[lang] (or matches an exact phrase): reject
if any word in allowlist[lang] is contained in normalized:
    # still need to check the rest of the name isn't independently bad —
    # a real implementation should strip the allowlisted span before the
    # substring check, not bail out entirely.
for stem in substring[lang]:
    if stem in normalized (outside any allowlisted span): reject
accept
```

## Where this is applied

Per technical-spec §11 (FAIR-5), the filter runs at **every point a name is
set**, never on read:

- account display-name write,
- `POST /api/sessions` (guest nickname) — this is the one that matters
  most: guests never touch the account path, and a guest's nickname is
  what shows on the daily board, the single most public surface in the
  product,
- challenge-lobby join (a joining player's nickname).

Rejection is a **friendly message** ("please choose a different name" —
not a screen dump of what matched or why), never a silent drop and never
applied retroactively to names already on a board.

## Adding entries

1. Normalize the term by hand first (accents off, lowercase, punctuation
   stripped) — that's the literal string you add.
2. Default to `exact`. Only reach for `substring` if you've checked for
   legitimate host words/names (dictionary + a moment's thought about
   surnames and place names) and found none — and if you did put something
   in `substring`, add the analysis to this README next to the existing
   ones above, the same way each current entry is justified.
3. Leetspeak/digit variants (`n1gger`, `f4g`, `c0nnard`) are separate
   `exact` entries, not something the matcher derives automatically —
   normalization does _not_ fold digits to letters (unlike accents), so
   `1`→`i`/`3`→`e` substitutions must be listed explicitly. Letter-doubling
   evasions (`connnard`) likewise get their own entry rather than fuzzy
   matching, to keep the matcher a simple, fast lookup.
4. Run whatever test suite covers this module before merging — it should
   include the Scunthorpe/Penistone/Lightwater/niggardly cases as
   permanent regression tests, not just entries that happen to sit in
   `allowlist`.

## Known limitation

This is a **blocklist, not moderation**. It catches direct, dictionary-form
slurs and vulgarity and a handful of predictable leetspeak variants — it
will not catch creative spacing beyond what normalization already
collapses, homoglyphs, context-dependent harassment, or slurs coined after
this file was last updated. It is a floor, not a ceiling: it exists so the
daily board isn't trivially defaced by the first guest who tries, not as a
guarantee that every offensive nickname is impossible.
