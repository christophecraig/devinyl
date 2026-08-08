# Catalog Probe Report — Deezer / MUS-8 Gate 0

**Status:** Complete
**Run date:** 2026-08-03
**Script:** [`scripts/catalog-probe.ts`](../scripts/catalog-probe.ts)
**Probe list:** [`scripts/probes.json`](../scripts/probes.json)
**Raw machine-readable output:** `scripts/.probe-results.json` (regenerated on every run, not committed)
**Owner:** Phase 0 tasks 0.1 / 0.2 / 0.3 / 0.5 of `docs/implementation-plan.md`

---

## 1. Summary

| Metric                                                         | Result               | Bar             | Verdict  |
| -------------------------------------------------------------- | -------------------- | --------------- | -------- |
| Track probes found on Deezer                                   | 85 / 85 (100.0 %)    | —               | —        |
| Track previews HTTP 200/206                                    | 85 / 85 (100.0 %)    | —               | —        |
| Track album hydration (genre + release_date)                   | 83 / 85 (97.6 %)     | —               | —        |
| **Combined pass rate** (found ∧ preview OK ∧ hydration OK)     | **83 / 85 (97.6 %)** | **≥ 95 %**      | **PASS** |
| Artist-only probes (plausible hit + ≥10 top tracks w/ preview) | 10 / 10 (100.0 %)    | —               | PASS     |
| CORS: preview responses carrying `access-control-allow-origin` | 10 / 10 (100.0 %)    | must be present | **PASS** |

**Overall Gate 0 catalog verdict: PASS.** The combined pass rate (97.6 %) clears the ≥ 95 % bar from technical-spec §5.5 with margin, the CDN serves fully-permissive CORS headers on preview MP3s (§4/§0.5), and artist-only search is reliable. Neither of the two failures is a coverage problem — see §3.

**Theme-seed (CREATE-5 free-text) verdict:** **Marginal / not v1-ready as an unscoped free-text field.** 6 of 8 theme seeds clear a 15/25-usable bar; 2 do not. See §5 for the recommendation.

No Gate-0 blocker was found.

---

## 2. Method

- 85 (artist, expected-track) probes, 10 artist-only probes, and 8 free-text theme probes were curated in `scripts/probes.json`, covering French chanson (Piaf, Brel, Brassens, Barbara, Aznavour, Gainsbourg…), variété (Goldman, Sardou, Balavoine, Souchon…), rock (Bashung, Indochine, Téléphone, Noir Désir), rap/urban (IAM, NTM, MC Solaar, Orelsan, PNL, Damso, Jul, Aya Nakamura, Booba, SCH, Ninho…), electro (Daft Punk, Air, Justice, Gesaffelstein), and current pop (Angèle, Stromae, Indila, Clara Luciani, Christine and the Queens…). Split ~51 % pre-2000 catalogue classics / ~49 % 2000+ current, deliberately including accented and apostrophe'd titles (_"Dis, quand reviendras-tu ?"_, _"L'Amour en solitaire"_, _"1000°C"_).
- `scripts/catalog-probe.ts` is a standalone `tsx` script with **zero app dependencies** — only Node builtins + `fetch`. It inlines its own normalizer (NFKD/accent-strip, lowercase, parenthetical/dash-suffix strip, `feat.` strip, punctuation strip) rather than importing from `src/`, since no app code exists yet.
- For each track probe: `GET /search/track?q=artist:"X" track:"Y"` (strict), falling back to a plain `q=artist title` search if the strict query returned nothing (0 probes needed the fallback in the final run). A candidate is accepted if its normalized title/title_short matches and its artist (or a contributor) matches.
- Preview check: `GET` the `preview` URL with `Range: bytes=0-1`, expecting 200/206; the `content-range` response header exposes the full resource byte length for free, letting duration be sanity-checked without downloading the whole file. A separate **full, non-Range GET on a 5-track subset** was also run per the literal task spec — see §6.
- Hydration check: `GET /track/{id}` → `GET /album/{album.id}`, requiring both a non-empty `genres.data` array and a non-null `release_date`.
- Artist probes: `GET /search/artist?q=`, then `GET /artist/{id}/top?limit=25`, requiring ≥10 returned tracks with a preview. Homonym handling: Deezer returns multiple small/unrelated artists sharing an exact normalized name (e.g. an obscure 31-fan "Angèle" ahead of the 1.7M-fan one in raw relevance order); the script picks the highest-`nb_fan` exact-name match, which is what a human curator would do.
- Theme probes: `GET /search/track?q=<theme>&limit=25`, judging each of the top 25 by (a) a French-plausibility heuristic (known-artist allowlist, French diacritics, or French stopword patterns in the title) and (b) a working preview.
- CORS (task 0.5): for 10 preview URLs from passing track probes, issued a `GET` with `Origin: https://example.com` + `Range: bytes=0-1`, and a separate `OPTIONS` preflight with `Origin` + `Access-Control-Request-Method: GET`. All headers recorded verbatim.
- Rate limiting: a single shared throttle across all Deezer API and CDN calls, capped at 8 concurrent / ≤38 requests per 5 s (Deezer's documented limit is 50/5s), with one retry + backoff on 429/5xx. The full run (85 track probes × ~4 requests each + 10 artist + 8 theme + 10 CORS + 5 duration-sanity ≈ 400 requests) completed in under 2 minutes with only a handful of 429-triggered retries, all of which succeeded on retry.
- Deezer is public/keyless for these read endpoints; no credentials were used or required.

---

## 3. Track-probe results

### 3.1 Per-genre-bucket breakdown

| Genre bucket | Pass   | Total  | Rate       |
| ------------ | ------ | ------ | ---------- |
| chanson      | 14     | 16     | 87.5 %     |
| variété      | 14     | 14     | 100.0 %    |
| rock         | 6      | 6      | 100.0 %    |
| pop          | 22     | 22     | 100.0 %    |
| rap          | 21     | 21     | 100.0 %    |
| electro      | 6      | 6      | 100.0 %    |
| **Total**    | **83** | **85** | **97.6 %** |

### 3.2 Per-era breakdown

| Era                | Pass | Total | Rate    |
| ------------------ | ---- | ----- | ------- |
| classic (pre-2000) | 41   | 43    | 95.3 %  |
| current (2000+)    | 42   | 42    | 100.0 % |

### 3.3 Every failure, with reason

| Artist      | Expected track                | Found? | Preview OK? | Hydration OK? | Reason                                                                                                                                    |
| ----------- | ----------------------------- | ------ | ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Édith Piaf  | La Vie en rose                | yes    | yes         | **no**        | `missing_genre_or_release_date` — album `genres.data` is an empty array (release_date present: `2013-10-10`, a 2013 remaster/compilation) |
| France Gall | Poupée de cire, poupée de son | yes    | yes         | **no**        | `missing_genre_or_release_date` — same failure mode, empty `genres.data` (release_date present: `2019-03-01`)                             |

Both failures are a genuine, narrow Deezer metadata gap: some older-catalogue album entries (remasters/compilation reissues of pre-1980s recordings) carry no genre tag even though title, artist, preview, and release date all resolve correctly. **Neither is a search-coverage or CORS/availability problem** — the track and its playable preview exist; only the `genre` field is empty for the specific album edition Deezer's search surfaced. Two mitigations for Phase 1 (§8): (a) fall back through alternate album editions of the same track when the top hit's album lacks a genre, since Deezer often has multiple pressings; (b) treat a track with a valid `release_date` but empty `genres` as **addable with a generic/unknown genre bucket** rather than hard-refusing it — the assembly-time policy in §5.4 requires availability (preview 200 + duration), not genre; genre is only used for decade/genre-bucketed distractor pools (§8.3), which can tolerate an "unknown" bucket.

### 3.4 Curation note

Five probes needed a title correction after the first run turned up `not_found` — these were **curation errors in the probe list, not catalog gaps** (verified against live search below and fixed before the final run reported above):

| Original probe                                     | Problem                                       | Correction                  |
| -------------------------------------------------- | --------------------------------------------- | --------------------------- |
| Serge Gainsbourg — "Poupée de cire, poupée de son" | Gainsbourg wrote it; France Gall performed it | Reattributed to France Gall |
| Jul — "Je ne sais pas danser"                      | Not a real Jul title                          | "Le monde est à moi"        |
| Booba — "Trop cool"                                | Not a real Booba title                        | "Validée"                   |
| Lomepal — "Flip"                                   | Not a real Lomepal title                      | "1000°C"                    |
| Superbus — "Lolita"                                | Actual title is "Lola"                        | "Lola"                      |

`scripts/probes.json` reflects the corrected list. This is a reminder that the probe list itself needs a human-plausibility pass before trusting a "not_found" result as a catalog gap.

---

## 4. Artist-probe results

| Query                    | Matched artist           | Top-track count | With preview | Pass |
| ------------------------ | ------------------------ | --------------- | ------------ | ---- |
| Jean-Jacques Goldman     | Jean-Jacques Goldman     | 25              | 25           | yes  |
| Stromae                  | Stromae                  | 25              | 25           | yes  |
| Angèle                   | Angèle                   | 25              | 25           | yes  |
| Orelsan                  | Orelsan                  | 25              | 25           | yes  |
| Aya Nakamura             | Aya Nakamura             | 25              | 25           | yes  |
| Georges Brassens         | Georges Brassens         | 25              | 25           | yes  |
| IAM                      | IAM                      | 25              | 25           | yes  |
| Christine and the Queens | Christine and the Queens | 25              | 25           | yes  |
| Booba                    | Booba                    | 25              | 25           | yes  |
| Zaz                      | ZAZ                      | 25              | 25           | yes  |

**10/10 pass.** One implementation note for `catalog/deezer.ts` (1.9): a naive "first exact-normalized-name match" picks the wrong artist for at least 2 of the 10 queries (Angèle, IAM) on raw Deezer search-relevance order, because Deezer returns several small homonymous/unrelated artists ahead of the famous one. The provider client must rank exact-name matches by `nb_fan` (or another popularity signal) rather than trusting result order — this bug would otherwise silently populate a generation pool or distractor pool from the wrong artist.

---

## 5. Theme-seed results (CREATE-5 free-text de-risking, §G item 8)

| Theme query                          | Total results | Sampled (top N) | French-plausible | Working preview | Usable (both) |
| ------------------------------------ | ------------- | --------------- | ---------------- | --------------- | ------------- |
| "bande originale de film"            | 245           | 25              | 21               | 25              | 21/25         |
| "années 80"                          | 181           | 25              | 19               | 25              | 19/25         |
| "chanson française"                  | 201           | 25              | 23               | 25              | 23/25         |
| "musique de Noël"                    | 286           | 25              | 17               | 25              | 17/25         |
| "comédie musicale française"         | 57            | 25              | 10               | 25              | **10/25**     |
| "rap français"                       | 203           | 25              | 18               | 25              | 18/25         |
| "chanson d'amour française"          | 188           | 25              | 24               | 25              | 24/25         |
| "génériques dessins animés français" | 13            | 13              | 7                | 13              | **7/13**      |

Aggregate: **139/188 sampled results usable (73.9 %)**. 6 of 8 seeds clear the ≥15/25 "usable" bar; **"comédie musicale française" (10/25) and "génériques dessins animés français" (7/13, and only 13 total candidates exist in the catalogue at all) do not.**

**Caveats on the numbers:** every probed theme returned a working preview for essentially 100 % of results — preview availability is not the constraint. The binding constraint is _topical relevance_: Deezer's `/search/track` free-text query is a general-purpose relevance search, not a curated "theme" or "mood" endpoint, so results drift toward loosely related or international (non-French) tracks past the first handful of hits. The French-plausibility heuristic here (known-artist allowlist + diacritics/stopword detection) is a probe-only approximation, not the ANS-quality judgment a human curator would make — it plausibly **undercounts** true positives (an English-titled French film score) as it also cannot judge whether a track is _actually thematically relevant_ (e.g. "années 80" mixing real 80s hits with newer songs that merely mention the 80s) versus merely French-plausible. Read the ratios as a ceiling on relevance, not a floor.

**Recommendation:** free-text theme search as an _unscoped, arbitrary_ CREATE-5 input is **not reliably viable for v1** — two of eight realistic seed phrases fall meaningfully short of a usable pool, and even passing seeds mix in off-theme results that a human would reject on sight. The safer v1 scope per §G item 8: ship CREATE-5 generation against **structured filters** (genre, decade, artist) which this probe run shows are reliable (100 % pass on artist-only search; genre/decade metadata is present on 97.6 % of tracks), and offer free-text theme search only as a **curated seed suggestion list** (a fixed set of pre-vetted theme strings like the classics above, each spot-checked once by an operator) rather than an open text field. Revisit true free-text once a better relevance/filtering layer exists (e.g. combining the query with a `chart`/`genre` filter, or hand-building small theme→artist-list mappings for the most common requests).

---

## 6. CORS findings (task 0.5) — Gate-0 audio-engine check

**Verdict: PASS.** The Deezer preview CDN (`cdnt-preview.dzcdn.net`) serves fully permissive CORS on every sampled preview MP3, for both the actual `GET` request and the `OPTIONS` preflight. The §4 audio engine's `fetch()` → `ArrayBuffer` → `AudioContext.decodeAudioData` approach is unblocked; **no fallback to a plain `<audio>` element is needed.**

Representative response, verbatim (`GET` with `Origin: https://example.com`, `Range: bytes=0-1`, track 3156614):

```
HTTP/1.1 206
access-control-allow-origin: *
access-control-allow-headers: Range
access-control-expose-headers: x-deezer-client-ip, content-length, content-range, Akamai-Request-BC,Akamai-Request-BC
access-control-max-age: 86400          (on the OPTIONS preflight)
timing-allow-origin: *
accept-ranges: bytes
content-type: audio/mpeg
content-range: bytes 0-1/479827
cache-control: public, max-age=12922988
vary: Origin
server: Google Frontend
```

`OPTIONS` preflight (same track), verbatim:

```
HTTP/1.1 200
access-control-allow-origin: *
access-control-allow-headers: Range
access-control-expose-headers: x-deezer-client-ip, content-length, content-range, Akamai-Request-BC,Akamai-Request-BC
access-control-max-age: 86400
timing-allow-origin: *
content-length: 0
vary: Origin
```

Findings:

- `access-control-allow-origin: *` was present on **10/10** sampled preview responses (`GET`) — an arbitrary browser origin (tested as `https://example.com`, deliberately unrelated to Deezer) is permitted to read the response body via `fetch()`.
- `timing-allow-origin: *` is also present, so `Resource Timing` data is not blocked either (a minor nice-to-have, not required by the audio engine).
- `access-control-allow-headers: Range` explicitly permits the `Range` header cross-origin, which the audio engine will want for partial fetches / scrubbing prevention (ROUND-2 has no scrub UI, but the preloader may still benefit from Range).
- The `OPTIONS` preflight returns `200` with the same permissive headers and `access-control-max-age: 86400` — browsers will cache the preflight result for 24h, so it costs nothing per-play after the first hit.
- One transient observation: a small number of `OPTIONS` and rate-adjacent requests hit `429` from the **CDN itself** (not just the metadata API) during this probe's deliberately fast/concurrent run — the CDN enforces its own request-rate ceiling independent of the api.deezer.com 50-req/5s limit. This is not a CORS problem, but it's a signal that a quiz preloader fetching many clips in parallel (MUS-7, "10 s timeout + one retry") should keep its own concurrency modest (the existing §4 budget of parallel-fetch-behind-a-progress-bar for ~10 clips is well within what was observed to work reliably here).
- `content-range: bytes 0-1/479827` on every sampled track exposes the full preview byte length "for free" from a 2-byte Range request. All 10 samples reported the same **479,827 bytes**, consistent with a fixed ~30 s / 128 kbps preview encode.

**Full-GET duration sanity check** (task 0.2 step 3, literal non-Range GET on a 5-track subset, to corroborate the Range-derived figure above):

| Track ID | Bytes downloaded | Estimated duration (128 kbps) | HTTP status |
| -------- | ---------------- | ----------------------------- | ----------- |
| 3156614  | 479,827          | 30.0 s                        | 200         |
| 2296855  | 479,827          | 30.0 s                        | 200         |
| 931797   | 479,827          | 30.0 s                        | 200         |
| 2420855  | 479,827          | 30.0 s                        | 200         |
| 14396298 | 479,827          | 30.0 s                        | 200         |

All five landed on exactly 30.0 s, matching Deezer's nominal 30-second preview length and the Deezer `duration` field's neighbourhood on the corresponding tracks. No Gate-0 blocker.

---

## 7. Metadata completeness

| Metric                                                             | Result                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Genre + release_date both present (of found tracks with a preview) | 83 / 85 (97.6 %)                                                          |
| Release_date present alone                                         | 85 / 85 (100.0 %)                                                         |
| Genre present alone                                                | 83 / 85 (97.6 %) — the same 2 tracks missing both are the sole genre gaps |

Genre is the weaker of the two fields, but only marginally, and only on a narrow class of catalogue-reissue albums (§3.3). Release-date availability is perfect across the sample. This supports building the `(genre, decade)`-indexed distractor pool (§8.3) as designed, with an "unknown genre" fallback bucket for the rare gap.

---

## 8. Recommendation

**Ship Phase 0's catalog decision as: proceed with Deezer, no fallback needed.**

- Combined pass rate 97.6 % clears the ≥95 % MUS-8 bar with room to spare, across every genre bucket and both eras — there is no weak corner of the French repertoire this probe found (chanson has the only sub-100 % bucket, still at 87.5 % / driven by the 2-track genre-metadata gap, not a search miss).
- CORS is unambiguously permissive on the CDN; the ArrayBuffer-based Web Audio engine (§4) can be built as specced with no `<audio>`-element fallback and no scoring-honesty caveat.
- Artist-only search is reliable for CREATE-5/generation pools, **provided** the provider client dedupes homonymous artists by popularity (a concrete fix needed in `catalog/deezer.ts`, task 1.9) — this was an actual bug caught by this probe, not a hypothetical.
- Free-text theme search (§G item 8) should **not** ship as an open field in v1; scope CREATE-5 to structured filters + a short curated list of pre-vetted theme seeds, as argued in §5.
- Two follow-ups for Phase 1: (a) genre-empty-album fallback/["unknown" bucket] handling in the catalog client (§3.3); (b) keep clip-preload concurrency modest given the CDN's own independent rate limiting observed here (§6).

No changes to the Deezer-vs-iTunes-fallback decision (§19) are warranted — this run gives no reason to open that door.

---

## 9. Re-run log (§17 drift detection)

The probe is not a one-off Gate-0 artifact — §17 wants it re-run to catch catalog
drift, and `.github/workflows/weekly-probe.yml` (plan S.6) now runs it every Sunday
and **fails the workflow below the 95 % bar**, so GitHub's scheduled-workflow
failure email is the alert channel. Manual re-runs land here.

| Run date   | Combined pass      | Found       | Preview OK  | Hydration    | Artist | CORS  | Verdict                                       |
| ---------- | ------------------ | ----------- | ----------- | ------------ | ------ | ----- | --------------------------------------------- |
| 2026-08-03 | **97.6 %** (83/85) | 85/85 100 % | 85/85 100 % | 83/85 97.6 % | 10/10  | 10/10 | Gate 0 baseline (§1–§8 above)                 |
| 2026-08-07 | **97.6 %** (83/85) | 85/85 100 % | 85/85 100 % | 83/85 97.6 % | 10/10  | 10/10 | **No drift.** Plan 4.14's "probe re-run" item |

The 2026-08-07 re-run reproduced the baseline exactly, sub-rate for sub-rate: the
same two hydration failures (empty `genres` on the Piaf and France Gall reissue
albums — a metadata gap, not a coverage gap), preview durations still a uniform
479 827 B ≈ 30 s across the sample, and `access-control-allow-origin` present on
10/10 preview responses. One transient 429 on a CDN preview fetch was absorbed by
the script's own backoff-and-retry, which is the CDN rate limiting §6 already
documents rather than a new signal.

Nothing here reopens §8's recommendation.
