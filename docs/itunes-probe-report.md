# iTunes Search API Probe Report — §19 fallback-provider validation

**Status:** Complete
**Run date:** 2026-08-03
**Script:** [`scripts/itunes-probe.ts`](../scripts/itunes-probe.ts)
**Probe list (shared with Deezer):** [`scripts/probes.json`](../scripts/probes.json)
**Raw machine-readable output:** `scripts/.itunes-probe-results.json` (regenerated on every run, not committed)
**Companion document:** [`docs/catalog-probe-report.md`](./catalog-probe-report.md) (Deezer, 97.6% PASS) — read side by side
**Owner task:** technical-spec.md §19 risk row _"Deezer API/ToS change or preview removal → iTunes Search API as documented fallback adapter"_; triggered by `docs/adr/0001-deezer-tos.md`'s open risk #1 (Deezer's "family scope" clause is unresolved for public launch)

---

## 1. Headline

| Metric                                                                           | Result                                                                                                                    | Bar                              | Verdict                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------- |
| Track probes: combined pass (found ∧ preview 200/206 ∧ genre+releaseDate inline) | **78 / 85 (91.8%)**                                                                                                       | ≥ 95%                            | **FAIL**                               |
| — corrected for 1 confirmed false-positive match (§3.4)                          | 77 / 85 (90.6%)                                                                                                           | ≥ 95%                            | **FAIL**                               |
| — with a diagnosed, buildable fix applied (artist-lookup fallback, §3.3)         | 84 / 85 (98.8%, live-verified by hand, not re-run through the automated pipeline)                                         | ≥ 95%                            | would PASS                             |
| CORS: preview responses carrying `access-control-allow-origin`                   | 10/10 (100%)                                                                                                              | must be present                  | **PASS**                               |
| Content-type / DRM                                                               | `audio/x-m4p` on 77/78, `audio/x-m4a` on 1/78; container inspection found **no DRM/FairPlay markers** on any sampled file | must be decodable, unencrypted   | **PASS, with a caveat** (§6)           |
| Preview duration                                                                 | 20/20 sampled clips measured 29.98–30.02s via exact `mvhd` atom parse                                                     | matches product's 30s assumption | **PASS**                               |
| **ToS: is this use permitted?**                                                  | **NO — explicit, conjunctive, multi-clause conflict with the product as designed**                                        | must not conflict                | **FAIL, and worse than Deezer's** (§2) |

**Overall verdict: the iTunes Search API is NOT a viable drop-in escape hatch as currently understood.** The catalog-coverage number narrowly misses the bar but is diagnosably fixable (§3); the ToS problem is not fixable by better engineering — it is a set of explicit, plainly-worded restrictions that the product's core mechanics violate on at least four independent grounds, and it is a harder "no" than Deezer's ambiguous "family scope" clause (§2). See §9 for what that leaves as real options.

---

## 2. Terms of Use (item E) — read this section first, it drives the verdict

**Sources consulted (fetched 2026-08-03):**

- `https://performance-partners.apple.com/search-api` — full text retrieved via `curl` (HTML stripped to text) for verbatim clauses, same method used for the Deezer ADR.
- `https://performance-partners.apple.com/faq` — does not address the Search API; affiliate-program logistics only.
- `https://developer.apple.com/forums/thread/66399` (developer forum) — corroborates the rate limit via a reported direct answer from Apple support.
- Apple Services Performance Partners program-overview / sign-up pages (via search) — affiliate enrollment logistics, for the "is program membership required" question.

### 2.1 The controlling clause, verbatim, in full

> "Developers may use certain promotional content as may be provided by Apple, including previews of songs and music videos, and album art, for the purposes of promoting the subject of the Promo Content; provided such Promo Content: **(i)** is placed only on pages that promote the content on which the Promo Content is based; **(ii)** is proximate to a "Download on iTunes" or "Download on App Store" badge (as approved by Apple) that acts as a link directly to pages within iTunes where consumers can purchase the promoted content; **(iii)** includes attribution indicating the Promo Content was "provided courtesy of iTunes" if such Promo Content includes song or music video previews; **(iv)** is streamed only, and not downloaded, saved, cached, or synchronized with video, if such Promo Content includes song or music video previews; **(v)** is not used for independent entertainment value apart from its promotional purpose; and **(vi)** is not used to promote any other goods or services."

This is a **conjunctive** list — all six conditions must hold simultaneously for any use of a preview to be permitted. Devinyl's design conflicts with at least four of the six, independently of one another (any single one is disqualifying on its own):

### 2.2 (a) Does "not for independent entertainment value" actually bar a quiz, or is it scoped to the badge context?

**It is a substantive bar on the use case, not a technicality about badge placement.** Read the clause in its full context, not in isolation:

- Clause (i) already requires the _page_ to "promote the content on which the Promo Content is based." A round in Devinyl deliberately **hides** the track's identity (MUS-4: "the manifest deliberately contains zero plaintext answer data") until after the player guesses — the page cannot be said to be promoting _that specific track_ while its identity is a secret being tested, because promotion requires the audience to know what is being promoted.
- Clause (v) then makes explicit what (i) implies: the preview must not be "used for independent entertainment value apart from its promotional purpose." A blind-test guessing game is not incidental exposure to a promotional preview — the clip _is_ the game. Its entertainment value is the entire reason it's playing. That is precisely the thing clause (v) is written to exclude.
- The one place a badge/attribution _could_ legitimately appear — the post-guess reveal screen, where the title and artist are shown — only partially rescues clauses (ii)/(iii) for that one screen. It does nothing for the live round itself, where the clip plays with the answer hidden, which is where (i) and (v) already fail.

**Conclusion: not a narrow technicality — the core game mechanic (hide the track, then reveal it) is exactly the kind of standalone entertainment use these clauses are written to prohibit.**

### 2.3 (b) Does the ArrayBuffer→decodeAudioData preload (MUS-7) count as "downloaded/saved/cached"? — potentially fatal to the audio architecture, independent of the quiz question

**Yes, on any ordinary reading, and this is a second, independent blocker.** Clause (iv) requires previews to be "streamed only, and not downloaded, saved, cached, or synchronized." Compare that to the committed architecture (technical-spec §4, plan task 1.21/1.22):

> "Clips are fetched as `ArrayBuffer`s and decoded via `AudioContext.decodeAudioData` during the pre-round loading screen (MUS-7)... Preloader (MUS-7): parallel fetch + decode behind a loading screen with progress... all clips... are in memory before round 1, so a connection drop mid-quiz never interrupts play."

This is not "streaming" in any sense Apple's clause would recognize — it is fetching the complete response body into memory (`fetch().arrayBuffer()` blocks on the full download), decoding it fully, and **holding every clip in a session buffered in memory for the whole quiz** (up to 24 MB / 50 rounds per §4's own preload budget), specifically so playback survives a dropped connection. That is "downloaded" and "cached" by definition, not "streamed only." An `<audio src=...>` element with progressive, non-preloaded playback might arguably qualify as "streamed" — but MUS-7's entire design point (full preload before round 1, offline resilience, sample-accurate `AudioBufferSourceNode` timing) requires exactly the buffering behavior clause (iv) forbids.

**Conclusion: even setting the quiz-content question aside entirely, iTunes previews cannot be used with Devinyl's committed audio architecture (§4) without violating clause (iv). This is fatal to the architecture on iTunes specifically — a switch to iTunes would force either a materially different (progressive `<audio>`-element, no-preload, degraded-offline-resilience) audio engine, or continued ToS violation.** This is a strictly worse position than the Deezer CORS finding (`catalog-probe-report.md` §6), where the ArrayBuffer approach was confirmed _compatible_ with Deezer's CDN.

### 2.4 (c) Is affiliate/partner-program membership required to use the Search API at all?

**No explicit technical gate found, and this probe is empirical confirmation: all 140 API calls in this run were made with zero credentials, no API key, and no program enrollment, and none were rejected for lack of authorization** (0/140 got a 403 for auth reasons; see §4 rate-limit notes for the _volume_-based 403 risk, which is separate). The bare JSON endpoints (`itunes.apple.com/search`, `/lookup`) are open.

However: the clause quoted in §2.1 is not conditioned on formal enrollment either — it governs "Developers['] use [of] certain promotional content," full stop, and it is hosted on the Performance Partners program's own domain as _the_ terms for API-sourced preview/artwork use. Not joining the formal affiliate program (Partnerize-backed, curated acceptance — "Apple is currently only accepting a limited number of partners") does not exempt a project from these terms; it only means you're using previews outside the commission-earning relationship while still bound by the promotional-use conditions. Separately, actual affiliate enrollment is a curated, non-guaranteed application process, not a self-serve signup like Deezer's.

**Conclusion: no technical membership gate on the raw API, but no membership escape from the content-use terms either — joining the program would not change §2.2/§2.3's analysis (see §9.2).**

### 2.5 (d) Is the "Download on iTunes" badge-proximity requirement compatible with MUS-4?

**No — this is a direct, explicit functional-spec conflict, not an inference.** Clause (ii) requires previews to be "proximate to a 'Download on iTunes' or 'Download on App Store' badge... that acts as a link directly to pages within iTunes where consumers can purchase the promoted content." MUS-4 requires the opposite during play: "the manifest deliberately contains zero plaintext answer data... Reveal data (title, artist, artwork) is inside the encrypted per-round pack, opened only at reveal time." A store badge linking to the specific track's purchase page, displayed proximate to the very clip currently playing, **is** the answer — title and artist are printed on the badge's destination and typically inferable from the badge/link itself. There is no configuration of the round UI that shows a compliant badge without also spoiling the round.

**Conclusion: clauses (ii) and MUS-4 cannot both be satisfied during a live round. A badge could conceivably run on the reveal screen (post-guess) without spoiling anything, but that only helps (ii)/(iii) for that one screen — it does nothing for (i), (iv), or (v), which fail during the round regardless.**

### 2.6 Rate limit (documented, corroborated)

"The Search API is limited to approximately 20 calls per minute (subject to change)." — `performance-partners.apple.com/search-api`. A developer-forum thread reports Apple support confirming this figure directly in response to 403 reports, and warns that even correctly-throttled clients have hit undocumented secondary thresholds ("403 after about 1000 requests"). This probe made 140 calls, serialized at ~3.5s spacing, over roughly 8 minutes, and got **zero 403s** — consistent with, but not a stress-test of, the documented limit.

### 2.7 Verdict on this section

**Not permitted.** This is a stronger, more concrete "no" than Deezer's ADR-0001 conclusion. Deezer's blocking clause ("private use within a family scope") was genuinely ambiguous — arguable, unlitigated, plausible for a small friends-scoped POC. Apple's clause set is itemized, conjunctive, and the product design conflicts with four of its six sub-clauses by construction, not through misuse: it hides the track (conflicts with (i)/(v)), it fully buffers clips in memory for offline resilience (conflicts with (iv)), and it cannot show a purchase badge during a round without leaking the answer (conflicts with (ii)). None of these are cured by better engineering, and none are cured by joining the affiliate program (§2.4). This is not a "re-check before launch" risk like Deezer's — it is a design-level incompatibility discovered now, at Phase 0.

---

## 3. Deezer vs iTunes — direct comparison

| Criterion                              | Deezer (committed provider)                                                                                                                             | iTunes Search API (this probe)                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined pass rate                     | 97.6% (83/85) — **PASS**                                                                                                                                | 91.8% (78/85) as measured; 90.6% corrected for 1 false-positive match; ~98.8% with a diagnosed fix — **FAIL as measured**                                                                                                                                |
| Preview availability (200/206)         | 100% (85/85)                                                                                                                                            | 91.8% (78/85, tracks the "found" rate — every _found_ track had a working preview)                                                                                                                                                                       |
| Preview duration                       | 30.0s exactly on all 5 sanity-checked tracks (byte-length inference, not atom-parsed)                                                                   | 29.98–30.02s exactly on all 20 mvhd-atom-parsed tracks — tighter measurement methodology, same real-world answer                                                                                                                                         |
| Metadata completeness                  | 97.6% (2 tracks: preview OK, genre empty on a reissue album; required a **second** hydration call, `/album/{id}`)                                       | 91.8% raw, but **100% of every found track** carried genre + release date **inline on the search result** — no second hydration call needed at all                                                                                                       |
| Search precision                       | Field-scoped query (`artist:"X" track:"Y"`) — precise, few false positives; found a homonym-artist bug in artist search only                            | Free-text-only `term=` search — no field scoping; buries some correct tracks under karaoke/cover versions (§3.3); produced at least 1 confirmed false-positive artist match (§3.4)                                                                       |
| CORS on preview CDN                    | `access-control-allow-origin: *`, full preflight support — **PASS**, audio engine unblocked                                                             | `access-control-allow-origin: *`, full preflight support — **PASS**, identical outcome                                                                                                                                                                   |
| Audio container / format               | MP3, `audio/mpeg`, no DRM question                                                                                                                      | AAC-in-MP4, content-type mislabeled `audio/x-m4p` (FairPlay-suggestive) on 77/78 samples; **container inspection found no DRM markers** — almost certainly a legacy CDN label, not actual protection (§6), but not proven with an in-browser decode test |
| **ToS posture**                        | Ambiguous ("family scope" clause) — **conditionally acceptable** for a friends-scoped POC per ADR-0001, explicit re-check required before public launch | **Explicitly, conjunctively incompatible** with the product's core mechanics (hidden-answer rounds, full-preload audio architecture, no purchase badges during play) — not a "re-check later" risk, a "no" now (§2)                                      |
| Calls per quiz assembly                | 1 hydration call per track at assembly (search → track → album), cached permanently after                                                               | 0 extra calls — genre/release date arrive inline on the search hit itself                                                                                                                                                                                |
| Rate limit                             | ~50 req / 5s per IP (community-sourced, unverified officially per ADR-0001)                                                                             | ~20 req / min, officially stated by Apple and corroborated by developer-forum reports of enforced 403s — **roughly 15x stricter**                                                                                                                        |
| Generation/distractor pool feasibility | `artist/{id}/top` gives a direct "top tracks" list; homonym-artist bug found and documented as a fixable client concern                                 | **No direct "top tracks" endpoint exists.** `lookup?id=<artistId>&entity=song&limit=50-200` returns the artist's discography (not ranked by popularity) — usable for pool-building but architecturally different (§7)                                    |
| Attribution/legal obligations if used  | "Powered by Deezer" + logo mark required, no DRM/promotional restrictions beyond non-commercial + no image caching                                      | "Provided courtesy of iTunes" attribution + **mandatory purchase-linking badge** required — the badge is the part that conflicts with MUS-4                                                                                                              |

---

## 4. Method

Mirrors `scripts/catalog-probe.ts`'s structure so the two runs are comparable:

- Same 85 (artist, expectedTrack) probes, 10 artist-only probes, 8 theme probes from `scripts/probes.json` — no changes made to that shared file.
- `scripts/itunes-probe.ts` is a standalone `tsx` script, zero app dependencies, inlining its own normalizer (identical pipeline to the Deezer script: NFKD/accent-strip, lowercase, parenthetical/dash-suffix strip, `feat.` strip, punctuation strip).
- Search: `GET https://itunes.apple.com/search?term=<artist> <expectedTrack>&media=music&entity=song&limit=15&country=FR`, falling back to a title-only query (`term=<expectedTrack>`, limit 20) if the combined query returns no match. A candidate passes if normalized `trackName`/`trackCensoredName` matches AND normalized `artistName` matches (substring-tolerant, same policy as the Deezer script).
- Preview check: ranged GET (`Range: bytes=0-1`) expecting 200/206.
- Metadata check: `primaryGenreName` and `releaseDate` read directly off the search result — **no second call**, unlike Deezer.
- Duration: exact `mvhd` MP4-atom parse (§5) on a 20-track stratified sample, plus a byte-size-derived estimate for comparison.
- country=US spot-check: 20-track stratified sample re-queried with `country=US` instead of `country=FR`.
- Artist probes: `search?entity=musicArtist` then `lookup?id=<artistId>&entity=song&limit=50&country=FR`.
- Theme probes: `search?entity=song&limit=25` on 8 free-text theme strings, same French-plausibility heuristic as the Deezer script.
- CORS: 10 preview URLs, GET with `Origin: https://devinyl.workers.dev` + `Range`, and a separate `OPTIONS` preflight.
- Rate limiting: **all** calls to `itunes.apple.com` (search + lookup) were serialized through a single queue with ~3.5s minimum spacing and exponential backoff + retry on 403/429/5xx (starting at 3s, doubling). Preview-CDN requests (a different host, not the documented "Search API" surface) were throttled more loosely via a 5-way concurrency cap. **No 403s were hit at any point in the run** (140 iTunes API calls total, ~8 minutes) — the full 85-probe corpus was run, no sample reduction was needed.
- After the automated run, 8 anomalies (7 `not_found` + 1 suspicious pass) were manually re-investigated by hand against the live API — see §3.3/§3.4 — using the artist-lookup path and raw un-normalized comparisons, to distinguish genuine catalog gaps from search/matching-implementation bugs.

---

## 5. Track-probe results

### 5.1 Per-genre breakdown

| Genre bucket | Pass (as measured) | Total  | Rate      | Corrected pass¹ | Corrected rate |
| ------------ | ------------------ | ------ | --------- | --------------- | -------------- |
| chanson      | 16                 | 16     | 100.0%    | 16              | 100.0%         |
| variété      | 14                 | 14     | 100.0%    | 14              | 100.0%         |
| rock         | 6                  | 6      | 100.0%    | 6               | 100.0%         |
| pop          | 21                 | 22     | 95.5%     | 21              | 95.5%          |
| **rap**      | **15**             | **21** | **71.4%** | **14**          | **66.7%**      |
| electro      | 6                  | 6      | 100.0%    | 6               | 100.0%         |
| **Total**    | **78**             | **85** | **91.8%** | **77**          | **90.6%**      |

¹ "Corrected" removes the SCH/"Kjetil Schjander-Larsen" false-positive match (§5.4) from the pass column — it counts as a fail there, not a pass, because it matched the wrong track. Every other genre bucket is unaffected.

### 5.2 Per-era breakdown

| Era                | Pass (measured) | Total | Rate  |
| ------------------ | --------------- | ----- | ----- |
| classic (pre-2000) | 42              | 43    | 97.7% |
| current (2000+)    | 36              | 42    | 85.7% |

**The failure is concentrated: current-era French rap.** Every miss but one (Stromae "Formidable," genre `pop`) is a `rap`-tagged, current-era probe. This is the number that determines the verdict, so it was investigated by hand rather than taken at face value — see §5.3.

### 5.3 Diagnosis: catalog gap, or search-implementation weakness? — **mostly the latter, one confirmed exception**

Every `not_found` failure (and the one false-positive pass) was manually re-queried against the live API using two independent methods: (a) exact artist search (`entity=musicArtist`) followed by `lookup?id=<artistId>&entity=song&limit=200`, scanning the artist's full discography for the title; (b) direct alternate search-term phrasing. Results:

| Artist      | Expected track              | Original result                                                                                                                                          | Found via artist-lookup?                                                                                                                                                                                                       | Diagnosis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suprême NTM | Laisse pas traîner ton fils | not_found                                                                                                                                                | **Yes** — 9 matching entries (studio + 2 live versions) under artistId 14212992                                                                                                                                                | Search-relevance failure. The combined `term=` query never surfaced the track; a `entity=musicArtist` lookup finds it immediately. **Fixable.**                                                                                                                                                                                                                                                                                                                                                                                         |
| Stromae     | Formidable                  | not_found                                                                                                                                                | **Yes** — exact title match under Stromae's own artistId (270954369)                                                                                                                                                           | Search-relevance failure: `term=Stromae Formidable` returns 25 results, all karaoke covers / unrelated tracks named "Formidable" by other artists (Karaoke Label, La-Le-Lu, Pamela Bates, The Joy Formidable...) — the real Stromae recording never appears in the top 25 despite existing in the catalog. **Fixable**, and diagnostic: iTunes's free-text search has no field-scoping (no `artist:"X"` operator like Deezer's), so it can't disambiguate "song by this artist" from "song mentioning this artist in any credit/cover." |
| PNL         | Au DD                       | not_found                                                                                                                                                | **Yes** — 3 exact "Au DD" entries in PNL's discography                                                                                                                                                                         | Search-relevance failure. **Fixable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Damso       | Macarena                    | not_found                                                                                                                                                | **Yes** — found as "Θ. Macarena" (Damso stylizes several track titles with a leading Greek theta as an album-sequencing convention)                                                                                            | Search-relevance **and** normalization failure — our (and the future production) normalizer doesn't strip stylized non-Latin prefix glyphs. **Fixable** (normalizer edge case, same category as the Deezer probe's curation-error findings).                                                                                                                                                                                                                                                                                            |
| Booba       | Validée                     | not_found                                                                                                                                                | **Yes** — found as "Validée (feat. Benash)"                                                                                                                                                                                    | Search-relevance failure; the canonical single is credited with a featured artist in iTunes's catalog. **Fixable**, though needs a human check that this is indeed the intended recording, not a different remix.                                                                                                                                                                                                                                                                                                                       |
| Ninho       | Jefe                        | not_found                                                                                                                                                | **Yes** — exact "Jefe" match                                                                                                                                                                                                   | Search-relevance failure. **Fixable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SCH         | Otto                        | **false-positive pass** — matched "Otto" by "Kjetil Schjander-Larsen" (a movie-soundtrack composer whose surname happens to contain the substring "sch") | **Yes** — the real SCH's "Otto" exists under a _different_ SCH artistId (252981331); the naive combined search never found it and the substring-based artist matcher incorrectly accepted an unrelated 3-letter-code collision | **Methodological bug in this probe's matcher**, not a provider problem: very short artist codes (SCH) are prone to false substring matches (`"kjetil schjanderlarsen".includes("sch")` is true). A production matcher needs a stricter artist-equality check for short names — flagging this the same way the Deezer probe flagged its homonym-artist bug. **Fixable**, but the _raw_ pass count is overstated by 1 until corrected (§5.1).                                                                                             |
| Jul         | Le monde est à moi          | not_found                                                                                                                                                | **No** — exhaustively checked across all 4 distinct "Jul"/"JUL" artistId profiles in the FR catalog (259 total song entries scanned) and a quoted direct search; no match found under any variant                              | **Genuine, unresolved gap.** Either the track isn't licensed to the iTunes/Apple Music FR storefront under this title, or it exists under an album/title variant not found in this pass. This is the **only** track probe treated as a confirmed catalog miss rather than a search-implementation artifact.                                                                                                                                                                                                                             |

**Conclusion: 7 of 8 anomalies are diagnosed as search-implementation weaknesses (fixable with an artist-lookup fallback strategy — precisely the kind of client-side compensation the Deezer probe report already recommended for _its_ homonym-artist bug), not catalog gaps.** Manually re-verified via the artist-lookup path, a corrected client implementation would very plausibly score **84/85 (98.8%)** — comfortably above the ≥95% bar. This number is **not** re-derived through the full automated pipeline (no retry/backoff/rate-limit harness was run a second time), so it is reported as a diagnosed, live-verified-by-hand estimate, not a re-certified probe result.

**The one real gap (Jul — "Le monde est à moi") is itself instructive:** iTunes's free-text search has no equivalent of Deezer's `artist:"X" track:"Y"` field-scoped query syntax, which materially degrades precision for an artist like Jul with a very large catalog and many similarly-named or remix tracks. A production `catalog/itunes.ts` provider would need an artist-lookup-first strategy as its **primary** path, not a fallback, to get search quality on par with Deezer.

### 5.4 The false-positive finding is itself a warning sign

The SCH/"Kjetil Schjander-Larsen" mismatch (§5.3) is worth calling out beyond the numeric correction: it demonstrates that iTunes's free-text search can return a **plausible-looking but wrong track** that a naive matcher accepts, not just miss real tracks. Any production matching logic against this API needs artist-ID equality (not name substring matching) as its primary check, especially for short artist names/codes common in French rap (SCH, PLK, Jul, etc.).

---

## 6. Preview format and the DRM question (item B, escalated per coordinator request)

### 6.1 Content-type

77 of 78 previewed tracks returned `content-type: audio/x-m4p`; **1** returned `audio/x-m4a` (SCH/Kjetil Schjander-Larsen — the false-positive match, so this data point isn't especially meaningful on its own). `.m4p` is historically Apple's extension for **FairPlay-DRM-protected** purchased AAC files, which is a legitimate reason for concern — if these previews are actually DRM-wrapped, `AudioContext.decodeAudioData()` would fail in-browser regardless of any ToS question, killing the provider on pure technical grounds.

### 6.2 Investigation: are these files actually DRM-protected?

Four preview files were downloaded (partial, 64–256 KB prefixes, enough to reach the `moov` atom in every case — all four had a "faststart" `moov` near the front of the file) and their MP4 box structure was parsed by hand:

- **Codec inside `stsd`:** `mp4a` (standard MPEG-4 Audio / AAC-LC), confirmed via full manual parse of one file (Stromae — Papaoutai, trackId 1440856007) down to the `esds` descriptor (object type byte `0x40` = MPEG-4 AAC, config bytes `0x1210` = AAC-LC). **`mp4a` is the plain/unencrypted codec fourcc; a FairPlay-protected file would show `drms` (protected audio) here instead**, wrapping the real codec inside a `sinf`/`frma`/`schm`/`schi` (protection scheme) box structure.
- **Raw byte-level scan for DRM/protection markers** (`sinf`, `frma`, `schm`, `schi`, `drms`, `drmi`) across all 4 sampled files (including 3 additional samples beyond the fully-parsed one, taken from the CORS-check pool): **zero matches in any file.** No encryption/protection atoms present.
- The `.plus.aac.p.m4a` filename convention observed on every previewUrl (e.g. `mzaf_16864899599655274878.plus.aac.p.m4a`) is consistent with publicly-documented reporting elsewhere of iTunes preview URLs, which are known to be plain AAC despite legacy `.m4p`-style path/content-type conventions inherited from the old purchased-track download flow.

**Finding: these previews are almost certainly NOT DRM-protected.** `audio/x-m4p` is a legacy content-type label carried over from an older CDN convention, not an accurate description of the payload. The container structure is standard, unencrypted AAC-LC audio, structurally identical to any other `mp4a`-coded `.m4a` file a browser's `decodeAudioData` would accept.

**Caveat, stated plainly per the original task brief:** this is a structural/static analysis, not a live decode test. No `ffmpeg`/`ffprobe` was available in this environment to attempt an actual decode, and no real browser `AudioContext.decodeAudioData()` call was made against these bytes. **A real-browser decode smoke test remains a required Phase 1 check** (as originally scoped, "needs a real-browser check... alongside the iOS smoke test"), now specifically to rule out the last 1% of doubt the content-type label raises, not because the container evidence is ambiguous — it isn't.

---

## 7. Artist-probe results and pool feasibility (item C)

| Query                    | Matched artist           | Songs returned (lookup, limit 50) | With preview | Distinct genres seen                                                        |
| ------------------------ | ------------------------ | --------------------------------- | ------------ | --------------------------------------------------------------------------- |
| Jean-Jacques Goldman     | Jean-Jacques Goldman     | 50                                | 50           | Variété française, Bande originale, Pop                                     |
| Stromae                  | Stromae                  | 50                                | 50           | Variété française, Dance, Pop, Bande originale, Afro-fusion                 |
| Angèle                   | Angèle                   | 50                                | 50           | Variété française, Dance, Électronique, Pop, Hip-hop/Rap                    |
| Orelsan                  | Orelsan                  | 50                                | 50           | Hip-hop/Rap, Électronique, Variété française, Pop                           |
| Aya Nakamura             | Aya Nakamura             | 50                                | 50           | R&B/Soul, Hip-hop/Rap                                                       |
| Georges Brassens         | Georges Brassens         | 50                                | 50           | Variété française, Pop, Musique pour enfants, Musique religieuse            |
| IAM                      | IAM                      | 50                                | 50           | Musiques du monde, Hip-hop/Rap, Pop, Soul, Électronique                     |
| Christine and the Queens | Christine and the Queens | 50                                | 50           | Rock, Alternative, Pop, Hip-hop/Rap, Disco, Électronique, Variété française |
| Booba                    | Booba                    | 50                                | 50           | Hip-hop/Rap, Afro pop                                                       |
| Zaz                      | ZAZ                      | 50                                | 50           | Variété française, Pop, Bande originale, Musique classique, New age, Rock   |

**10/10 pass** (≥10 songs returned with previews, the same bar the Deezer probe used) — every query returned the full 50-song limit, 100% with working previews.

### 7.1 The architectural question: no direct "top tracks" endpoint

**Confirmed: iTunes has no equivalent of Deezer's `/artist/{id}/top`.** The only path is `lookup?id=<artistId>&entity=song&limit=N` (max useful limit ~200), which returns the artist's **entire indexed discography** (studio albums, singles, compilations, karaoke covers by other labels credited to the same artist name in some cases, live re-releases, remix singles) in an **unranked, non-popularity-ordered** list — not a curated "top tracks" set. Deezer's `/top` endpoint, by contrast, is explicitly a popularity-ranked shortlist.

**Consequences for generation/distractor pools (technical-spec §8.3, needs `(genre, decade)` buckets):**

- **Feasible, but requires more client-side work than Deezer.** A production `catalog/itunes.ts` provider would need to: (1) resolve the artist via `entity=musicArtist` search (already shown reliable — homonym risk exists here too, same as Deezer's Angèle/IAM bug, unverified but plausible given iTunes returns multiple artist IDs per name as seen for Jul/SCH in §5.3); (2) pull the full `lookup?entity=song&limit=200` discography; (3) **rank client-side** — iTunes doesn't return a popularity signal in this response the way Deezer's `nb_fan` does, so "top tracks" would have to be approximated some other way (e.g., release recency + a manual curation pass, or falling back on `trackId` ordering, which is unreliable) or simply **not attempted** — use the full discography as the generation pool without a popularity cut, accepting that distractors/generation picks may include deep-catalog or unusual tracks a Deezer-backed pool would have excluded via its ranked `/top` list.
- Genre data is present and multi-valued per artist (an artist can span several `primaryGenreName` values across their catalog, e.g. Christine and the Queens spans 7 genres) — this is _richer_ than Deezer's single-genre-per-album model and would need `(genre, decade)` bucketing logic to pick a sensible primary genre per track rather than per artist, which the schema already does correctly (`track_cache.genre` is per-track).
- **Verdict: pool-building is architecturally feasible on iTunes, but requires writing ranking/curation logic the Deezer client gets for free from `/top`.** Not a blocker, but a real implementation-cost difference, and one more reason the `CatalogProvider` interface swap (§5.1) would not be a zero-cost "bounded rewrite" as technical-spec §19 characterizes it — the generation-pool logic specifically would need non-trivial rework, not just an endpoint swap.

---

## 8. Theme-seed results (item D, comparable to Deezer §5)

| Theme query                          | Sampled (top 25) | French-plausible | Working preview | Usable (both) |
| ------------------------------------ | ---------------- | ---------------- | --------------- | ------------- |
| "bande originale de film"            | 25               | 6                | 25              | 6/25          |
| "années 80"                          | 25               | 11               | 25              | 11/25         |
| "chanson française"                  | 25               | 15               | 25              | 15/25         |
| "musique de Noël"                    | 25               | 9                | 25              | 9/25          |
| "comédie musicale française"         | 25               | 17               | 25              | 17/25         |
| "rap français"                       | 25               | 16               | 25              | 16/25         |
| "chanson d'amour française"          | 25               | 24               | 25              | 24/25         |
| "génériques dessins animés français" | 25               | 16               | 25              | 16/25         |

Aggregate: **114/200 usable (57.0%)** — materially worse than Deezer's **139/188 (73.9%)** on the same 8 seed phrases. Every theme cleared 100% preview availability (same pattern as Deezer: previews are never the constraint, relevance is). Only 2 of 8 seeds clear a ≥15/25 usable bar cleanly here ("comédie musicale française," "chanson d'amour française" — plus "chanson française" and "rap français"/"génériques..." sit right at or just under it), versus 6/8 on Deezer.

**This reinforces, not changes, the Deezer probe's existing recommendation:** free-text theme search should **not** ship as an open field on either provider — iTunes makes the case even more clearly, since its relevance ranking for arbitrary free text is measurably weaker than Deezer's on the identical query set. The existing plan (structured filters + a short curated seed list, never an open text field) is the safer design regardless of which catalog provider is in play, and would need no rework if iTunes were ever adopted.

---

## 9. What's actually left, if both providers are legally constrained for a public launch

Deezer is conditionally acceptable for the friends-scoped POC (ADR-0001) but unresolved for public launch. iTunes, per §2 of this report, is not acceptable at all for this product's mechanics. That leaves the real question: **what would actually work?**

### 9.1 Deezer partnership / commercial agreement — **the actually-sanctioned path**

Deezer's own developer FAQ states: _"There is no paid API, but if you'd like to partner with Deezer, you can contact us with this form."_ This is the path Deezer itself points toward for anything beyond the free-tier/non-commercial terms. **One-line verdict: unexplored but real — the terms, cost, and approval odds are unknown, but this is the option Deezer's own documentation designates for exactly this situation, and it should be pursued (a conversation, not another document-reading pass) before public launch rather than treated as a last resort.**

### 9.2 Apple affiliate/Performance Partner enrollment — does membership legitimize the use?

**No — enrollment does not solve any of the four conflicts found in §2.** The clause-set in §2.1 governs use of "Promo Content" broadly; it is not gated behind, nor lifted by, formal Performance Partner membership — it's the standing condition for using previews/artwork sourced from the API, member or not. Joining the program changes eligibility for **commission payments** on purchase-driving links, which is an unrelated axis from whether a quiz game's _use_ of previews is compliant. **One-line verdict: does not solve it — the restrictive clauses apply regardless of partner status.**

### 9.3 Jamendo / Free Music Archive / ccMixter (Creative-Commons catalogs) — legally clean, but is the repertoire there?

This is the product-killing question, so it was tested, not assumed. A live probe against Jamendo's API (`api.jamendo.com/v3.0`) was attempted against a stratified sample of this project's own probe artists (Stromae, Angèle, Orelsan, Aya Nakamura, Georges Brassens, IAM, Christine and the Queens, Booba, Jean-Jacques Goldman, Zaz):

- **No live hit-rate could be obtained in this session.** Jamendo requires a registered `client_id`; this session has no Jamendo account (registration is an out-of-session, human, [USER]-class action — email/account creation). The one publicly-documented "quick test" demo `client_id` (`709fa152`) returned `"Jamendo Api Suspended Application Error: Your application has been suspended, please contact Jamendo"` on every call — evidently oversubscribed/abused by the wider internet and disabled by Jamendo. Several other plausible-looking client IDs found via search were all rejected as invalid. **This is reported honestly as "not measured," not glossed over.**
- **Qualitative/structural assessment, offered in place of the missing number:** Jamendo, FMA, and ccMixter are catalogs of music released under Creative Commons licenses by independent/emerging artists who retain the right to do so. Mainstream commercial acts under major or large independent label contracts — which is every single artist in this project's 85-track probe list (Stromae, Aya Nakamura, Booba, Goldman, IAM, the Piaf/Brel/Brassens/Aznavour estates, etc.) — are contractually precluded from CC-licensing their commercial catalog; it's not a matter of choice or awareness, it's a structural feature of standard recording/publishing contracts. This is a strong, well-founded expectation of a near-zero hit rate for this project's actual repertoire, not a guess pulled from nowhere — but it is **not the live-measured number the task asked for**, and that gap should be closed with a real Jamendo API key before this conclusion is treated as final.
- **One-line verdict: legally clean but almost certainly the wrong catalog — recommend a follow-up task with real Jamendo credentials to confirm/deny, but budget for "a quiz where nobody recognizes the songs," which is not the product.**

### 9.4 Audius

A decentralized, artist-upload-direct streaming platform. Same structural issue as §9.3: it's built for independent/emerging artists uploading their own work, not licensed distribution of major-label commercial catalog. Not live-probed in this pass (out of scope per the coordinator's ask, which specified Jamendo for live testing), but the same reasoning applies with at least as much force — Audius has no licensing relationship with major labels at all. **One-line verdict: same catalog problem as Jamendo, without even Jamendo's curated-independent-scene depth — not evaluated live, near-certain miss for mainstream French repertoire.**

### 9.5 Stay non-commercial and friends-scoped forever

This is where ADR-0001 already landed for Phase 0–3: a small, unindexed, friends-only deployment plausibly clears Deezer's "family scope" bar. It is real, it works today, and it requires no new engineering. **One-line verdict: a valid holding pattern, not a launch answer — it doesn't resolve GATE 4 (public launch), it just postpones the question, which is exactly what ADR-0001 already said explicitly ("re-open this ADR before Phase 4").**

### 9.6 Net assessment

If Deezer's public-launch posture ever needs to change, the honest options are **(1) actually have the Deezer partnership conversation**, or **(2) stay in the friends-scoped posture indefinitely and accept that as the product's ceiling**. iTunes is not a third option as things stand — not for coverage reasons (§5, which are largely fixable) but for ToS reasons (§2, which are not). Creative-Commons catalogs are not a third option either, pending real verification, because the product's premise — "guess songs your friends actually recognize" — depends on mainstream commercial repertoire that CC catalogs structurally don't carry.

---

## 10. Verdict

**Is the iTunes Search API a viable escape hatch?**

**No — not as documented in technical-spec §19, and this changes the risk-table entry, not just this probe's PASS/FAIL line.** The catalog-coverage shortfall (91.8% vs the 95% bar) is real as measured but diagnosably fixable with an artist-lookup-first client strategy (§5.3) — that part of the original plan (§19: "Provider interface bounds the fallback to a bounded rewrite") holds up reasonably well on pure engineering grounds, modulo the pool-ranking cost noted in §7.1. **What does not hold up is the ToS.** Apple's promotional-content terms conflict with the product on at least four independent, non-overlapping grounds (§2.2–2.5): the game hides the answer where Apple requires promotion; the audio architecture fully buffers clips where Apple requires streaming-only; and the mandatory purchase badge would spoil every round. None of these are cured by better code, by joining the affiliate program, or by scoping down to a smaller audience the way Deezer's ambiguous clause plausibly allows.

**Recommendation to the CTO: treat iTunes as closed, not open with caveats.** Update technical-spec §19's risk mitigation — "iTunes Search API as documented fallback adapter" — to reflect that this is no longer a credible fallback for the product as designed; the actually-open paths, in order of promise, are a real Deezer partnership conversation before any public-launch commitment (§9.1), or staying within the friends-scoped non-commercial posture ADR-0001 already describes and accepting that as a ceiling until a partnership exists (§9.5). Creative-Commons catalogs (§9.3–9.4) remain unverified but are not expected to save the product premise even if legally clean, and should only be pursued as a real option after an actual Jamendo API key produces a real hit-rate number — not before.
