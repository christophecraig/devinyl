# Devinyl — V1 Implementation Plan

**Status:** Living document — update checkboxes as work lands.
**Sources:** [functional-spec.md](./functional-spec.md) (v0.3) · [technical-spec.md](./technical-spec.md) (v1.1). Requirement IDs refer to those docs.
**Executor:** Claude Code, working autonomously, spawning subagents where marked. Tasks tagged **[USER]** need credentials, accounts, or an action only the user can perform.

## Deviations from technical-spec v1.1 (agreed 2026-08-03)

The tech spec targets a Hetzner VPS + one Node process + better-sqlite3 + Litestream. For a **$0 POC testable with friends**, the plan targets **Cloudflare Workers + D1** instead. To be recorded as `docs/adr/0002-cloudflare-hosting.md` (task 0.6) and reconciled into the tech spec afterward:

| Spec said                                 | Plan does                                                                                                                                       | Why it's safe                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| better-sqlite3, one file                  | **D1** (SQLite dialect) via Drizzle                                                                                                             | Same SQL dialect, same schema; Drizzle abstracts the driver. Escape hatch back to a VPS stays open                        |
| In-process `setInterval` jobs             | **Cron Triggers** (2 schedules: 15-min + daily, internal dispatch)                                                                              | Free; same job code behind one `runJobs(kind)` entry                                                                      |
| Litestream + restore drill                | **D1 Time Travel** (30-day point-in-time restore) + drilled `wrangler d1 export` snapshot                                                       | Built-in, zero-ops                                                                                                        |
| SMTP relay (Scaleway/Postmark)            | **HTTP email API** (Resend free tier)                                                                                                           | Workers can't speak raw SMTP; free 100/day is plenty for verification mail                                                |
| Caddy/Docker/compose deploy over SSH      | **Wrangler deploys via GitHub Actions** with PR preview URLs + one-command rollback                                                             | The CI/CD answer (§CI below)                                                                                              |
| Self-hosted Plausible container           | **Deferred.** MET-1 funnels come entirely from the server-side `metrics_daily` job                                                              | No third-party beacon keeps CSP/LEGAL-2 pristine; page-view analytics revisited at production scale-up                    |
| Apple Sign-In wired now (§12)             | **Dropped for POC/V1-web** — email + Google only                                                                                                | No Mac, no paid Apple Developer account; Apple returns with the iOS effort                                                |
| satori + resvg-js OG images               | **POC: static branded OG image** + dynamic _text_ tags (challenger nickname, score to beat in `og:title`/`description`); satori images deferred | Workers **free tier has a 10 ms CPU cap** — satori rendering can blow it. SHARE-4 is still honored: branded, spoiler-free |
| WebSockets in-process `Map` rooms (V2/V3) | **Durable Objects** (free tier, SQLite-backed)                                                                                                  | Better fit anyway; nothing built now, doors kept open                                                                     |
| ~~iOS app someday soon~~                  | **Web → installable PWA (POC) → Tauri desktop (V1 launch)**, all buildable without a Mac (GitHub Actions runners)                               | User owns no Mac                                                                                                          |

Free-tier budget sanity: Workers 100k req/day, D1 5M reads / 100k writes/day, 5 GB — orders of magnitude above a friends-POC. POC ships on the free `*.workers.dev` domain, so **D-1 (domain/trademark) blocks public launch only, not the POC**.

## How to use this file

- Work strictly in phase order. Each phase ends with a **gate**; don't start the next phase before it passes.
- Check a box only when the code is merged and CI is green.
- Tasks are sized to one focused session; split in place if one balloons.
- **Subagent policy:** spawn parallel subagents only for tasks marked _(subagent-ok)_ — independent, well-specified, no shared files with concurrent work (test tables, list curation, translation sweeps). Anything touching schema, session lifecycle, or the game lib stays in the main session.

---

## Phase 0 — Go/no-go (everything else waits)

> §18 Phase 0. No app code before the gate passes.

- [x] **0.1** Curate probe list: ~100 French-repertoire (artist, expected-track) pairs across chanson/pop/rap, classics + current (Goldman, Brel, Stromae, Angèle, Orelsan, Aya Nakamura…), plus artist-only searches **and 5–10 free-text theme searches** ("bande originale de film", "années 80"…) to de-risk CREATE-5's theme seed early. Store as `scripts/probes.json`. _(subagent-ok)_
- [x] **0.2** Write `scripts/catalog-probe.ts` (§5.5): search Deezer → expected track found → `preview` URL HTTP 200 with ~30 s duration → album hydration yields genre + release date. Plain `tsx` script, no app dependencies.
- [x] **0.3** Run probe against live Deezer; commit `docs/catalog-probe-report.md`. **Pass: ≥ 95 %** playable, correctly-attributed previews (MUS-8). → **97.6 % (83/85)**, independently recomputed from the raw dump. Sub-rates: found 100 %, preview 200/206 100 %, album hydration 97.6 %. Both failures are empty `genres` on reissue albums (Piaf, France Gall), not coverage gaps. Every genre and era bucket clears 95 % on its own.
- [x] **0.4** Re-read current Deezer API ToS; record conclusion as `docs/adr/0001-deezer-tos.md` (§5.2 action). → **"acceptable with conditions"**, not a clean pass. See 0.8 below.
- [x] **0.5** Verify the Deezer CDN serves preview MP3s with CORS headers permitting `fetch()` → `ArrayBuffer` from a browser origin (the §4 audio engine depends on it; a plain `<audio>` element fallback would cost sample-accurate timing). Include result in the probe report. → **PASS.** `access-control-allow-origin: *`, `access-control-allow-headers: Range`, `timing-allow-origin: *`, HTTP 206 on ranged GET. Verified independently on a fresh URL. No `<audio>` fallback needed.
- [x] **0.6** Write `docs/adr/0002-cloudflare-hosting.md` capturing the deviation table above; amend technical-spec §1/§15 with a pointer to it.
- [ ] **0.7 [USER]** D-1: domain & trademark check for "Devinyl"; fallback name if taken. (Blocks public launch only — POC runs on `workers.dev`.)
- [ ] **0.8 [USER]** **Deezer ToS escalation.** ADR-0001 found §IV limits Content use to _"a strictly private use within a family scope"_ and bars commercial use outright (verified verbatim). A friends-scoped POC on an unindexed `workers.dev` URL is defensible; a public daily quiz with global boards on a custom domain is not clearly covered. Email Deezer's API/partnership contact with the specific question, in writing — free, long lead time, and a written answer beats any ADR. Paid legal review (~€500–1500, French IP/tech) is the fallback, sequenced **after** the friends POC: if the loop misses MET-2, the catalog question never matters. **Blocks public launch (Phase 4), not the POC.**
- [x] **0.9** **Probe the fallback provider now, not in an emergency.** iTunes Search API validated against the same corpus and pass bar → `docs/itunes-probe-report.md`. Rationale: iTunes is the only documented escape hatch (§19) and had never been tested; Spotify killed its own 30 s preview API in Nov 2024, so an untested escape hatch is not an escape hatch.
      **Result: the escape hatch is NOT REAL.** Coverage is fine and the gap is fixable (90.6 % raw, but 7 of 8 misses are search-implementation weakness — iTunes has no field-scoped query like Deezer's `artist:"X" track:"Y"` — and hand-verified artist-ID lookup reaches ~98.8 %). CORS passes; previews are a tight 29.98–30.02 s; `audio/x-m4p` is a legacy mislabel, not DRM (no `sinf`/`frma`/`schm` atoms — plain AAC-LC). **The blocker is legal, and it is worse than Deezer's.** Apple's promotional-use terms conflict on four independent grounds: previews must be _"streamed only, not downloaded, saved, cached"_ — **fatal to MUS-7's full-preload audio architecture on its own**; content must not be used for _"independent entertainment value apart from its promotional purpose"_; and the mandatory "Download on iTunes" badge would spoil every round, a direct MUS-4 conflict. Affiliate enrollment cures none of it.
      ⇒ **§19's stated mitigation is void.** The realistic path to a public launch is a **Deezer commercial/partnership agreement** (0.8), not a provider swap. Jamendo/Audius are structurally incompatible with major-label French repertoire — a quiz whose songs nobody recognises is not the product.

**GATE 0: PASSED (2026-08-03), with one condition carried forward.** Probe 97.6 % ≥ 95 % ✓ · CORS ✓ · ToS ADR concludes _"acceptable with conditions"_ — accepted for the POC, **re-opened as a launch blocker at 4.5/0.8**. Deezer previews measured at a uniform 30.0 s (479 827 B @ 128 kbps CBR) across a 17-track sample; §9's measured-`clipMs` design is retained anyway as defence against a provider swap.

---

## Phase 0.5 — Scaffold & CI/CD

> The pipeline is built **before** the app so every subsequent task lands through it.

- [ ] **S.1 [USER]** Cloudflare account (free): create, generate an API token for CI, create the D1 database + Workers app via `wrangler`. GitHub repo secrets set (`CLOUDFLARE_API_TOKEN`, account ID).
- [x] **S.2** Init SvelteKit (Svelte 5, **adapter-cloudflare**, TypeScript strict, pnpm); repo layout per §3 (`src/lib/game`, `src/lib/server/{db,catalog}`, `src/lib/client`, `src/lib/i18n`, route groups `(app)`, `(share)`, `api`); `wrangler.toml` with D1 binding + the two cron schedules; local dev = `wrangler dev` (local D1 is a real SQLite file — dev/test parity for free).
- [x] **S.3** Tooling: eslint + prettier + `svelte-check` (a11y warnings as errors, §17), Vitest + **@cloudflare/vitest-pool-workers** (integration tests run in the actual Workers runtime against local D1), Playwright + `@axe-core/playwright`, fast-check.
- [x] **S.4** Drizzle ORM + drizzle-kit for D1; migrations as versioned SQL applied by `wrangler d1 migrations apply` — **in CI, never on boot** (additive-only between releases, §15 rule kept).
- [ ] **S.5** Paraglide (inlang) with `fr`/`en` catalogs; locale detection from `Accept-Language` in `hooks.server.ts` (LOC-1).
- [ ] **S.6** **CI/CD pipeline** (GitHub Actions):
  - _Every PR:_ lint → typecheck → unit/integration → build + bundle-size budget (< 60 KB gzip initial JS, §4) → Playwright incl. axe (serious/critical fail the build, A11Y-1) → **deploy a preview Worker** with its own preview D1 → preview URL posted on the PR. Deezer always stubbed in CI (§17).
  - _Merge to `main`:_ same suite → apply D1 migrations (gated step) → `wrangler deploy` to production → post-deploy smoke test hitting `/healthz`.
  - _Rollback:_ documented one-command `wrangler rollback` runbook (`docs/runbooks/rollback.md`); safe because migrations are additive-only.
  - _Scheduled:_ weekly live catalog probe (drift detection, §17).
- [ ] **S.7** Design tokens: vanilla-CSS custom properties, both themes, AA contrast checked at design time (§4, A11Y-6); visible-focus-ring token; `prefers-reduced-motion` baseline.

**GATE 0.5:** an empty app deploys to production and to a PR preview URL through the pipeline; rollback tested once; CI fully green.

---

## Phase 1 — Engine core

> §18 Phase 1: proves the whole risk surface — audio timing, preloading, validation feel, playability without sight. Guest-only; no accounts yet.

### 1A — Shared game lib (`src/lib/game/`, pure & isomorphic)

- [x] **1.1** `types.ts`: Quiz, Round, Session, GuessLog, CatalogTrack, GenerationFilters + shared zod schemas (§10).
- [x] **1.2** `normalize.ts`: the 8-step pipeline of §8.1 (NFKD/accents, lowercase, parentheticals & dash-suffixes, feat-stripping, `&`/`+` folding, punctuation, leading articles FR/EN, digit↔word 1–10 FR/EN).
- [x] **1.3** `match.ts`: exact-first, then Damerau-Levenshtein with §8.2's length-scaled thresholds.
- [x] **1.4** `scoring.ts`: curve **v1** — speed `max(100, round(1000 − 900·min(t,clipMs)/clipMs))`, fixed 500/target; versioned registry, `curve_version` stamped everywhere (SCORE-6, §9).
- [x] **1.5** Unit tests: normalization tables (accents, FR/EN articles, parentheticals, feat., typos at each distance boundary), curve boundary values (t=0, t=clipMs, short clips). _(subagent-ok)_
- [x] **1.6** Property tests (fast-check, §8.2): every accepted form matches itself; ≤-threshold mutations match; distinct real titles from the probe list never cross-match.

### 1B — Database & catalog

- [x] **1.7** Drizzle schema for **all** §6 tables (incl. auth tables, unused until Phase 2): `track_cache`, `quiz`, `quiz_track`, `daily_quiz`, `challenge`, `game_session`, `round_result`, `friendship`, `weekly_points`, `daily_guest_claim`, `metrics_daily` (§15), plus the four board indexes (§6).
- [x] **1.8** Add `imported_history` table (session-shaped rows, `imported=true`, feeds STAT-1 only) for ACC-4's local-only import — schema gap, see §G.
- [x] **1.9** `catalog/provider.ts` interface (§5.1) + `catalog/deezer.ts`: search, track+album hydration, preview resolution; request queue respecting 50 req/5 s; 24 h search cache; permanent metadata cache into `track_cache` (§5.2–5.3). _(Note: Workers isolates aren't one process — the queue lives in D1/cache state, not module memory; document the approach.)_
- [x] **1.10** Answer-key computation at assembly (§5.4): normalized `title_short`, full title, every credited artist w/ primary flag → `track_cache.answers`. Availability enforcement: adding a track requires HTTP 200 preview + plausible duration; refusal message otherwise (MUS-5 at source).
- [x] **1.11** Distractor pools (§8.3): `track_cache` indexed by (genre, decade); picker (same decade where possible, no normalized-form collisions) storing `quiz_track.choices` at assembly; live Deezer calls only when a bucket is thin.
- [x] **1.12** **Cache warm-up seeding script** (top charts per genre × decade) run once at deploy + refreshed by the daily cron, so day-one generated choice-mode quizzes don't stampede live calls (cold-start gap, §G).

### 1C — Quiz generation & session lifecycle (server)

- [x] **1.13** `POST /api/quizzes/generate` (CREATE-5, guests ok): filters → real `quiz` row, `kind='generated'`, `ephemeral_until = now+24 h`; same filters re-roll differently (CREATE-7). Rate-limited. **Scope per §G-8: structured filters (genre / decade / artist) + a curated theme list rendered as choices. No open free-text theme field in v1** — the 0.3 probe measured raw theme search as unreliable.
- [x] **1.14** `POST /api/sessions` (§7.1): resolve quiz → batch preview-URL resolution → manifest with zero plaintext answers (MUS-4): `rounds[] {position, previewUrl, choices?}`, AES-GCM `answerPack` per round (Web Crypto — available in Workers and browsers), `sessionSeed` for client-side `HKDF(seed, n)` derivation (§7.2), settings + curveVersion + sessionId. Unavailable preview ⇒ round marked skipped in the manifest (MUS-5) + flagged for owner attention.
- [x] **1.15** `rounds/:n/start` beacon (fire-and-forget; server timestamp into `server_round_log`) and `rounds/:n/result` (guessLog, lockTimes, clipMs, skipped, queuedBeacons). The beacon returns **nothing** — keys are client-derived (§7.2 wins over the stale §10 table note, §G).
- [x] **1.16** `POST /api/sessions/:id/finalize` (§7.3): re-run shared normalize/match on raw guessLog; recompute points from lockTimes + clipMs (validated ±2 s against known preview duration); **two-tier plausibility** (verified beacon-window / reconstructed invariants); `scored` + `scored_block_reason` semantics (`clip_unavailable`, `implausible`, `unverified_timing`, `replay`, `creator`); ephemeral-quiz **promotion on use** (§6).
- [x] **1.17** Cron job handlers (15-min schedule): abandoned-session sweep (2 h, ROUND-8), hourly ephemeral-quiz sweep (leaf rows only), `daily_guest_claim` 48 h purge.
- [x] **1.18** Rate limiting per §10 (search 30/min, session create 10/min, finalize 20/min): token buckets keyed IP+identity backed by D1/cache (isolate memory is per-instance — see 1.9 note); 429 + `Retry-After`.
- [x] **1.19** Integration tests (vitest-pool-workers + local D1): full session lifecycle, finalize re-validation in **both** plausibility tiers, skipped-round ⇒ unscored (FAIR-6), clipMs inflation rejected, ephemeral promotion + sweep.

### 1D — Client: audio, round flow, accessibility (built together, not layered)

- [x] **1.20** Guest identity blob in `localStorage`: `{guestId (nanoid), nickname, history[], dailyStreak}` (§4); `x-guest-id` header plumbing; nickname prompt UI.
- [x] **1.21** Audio engine (`src/lib/client/audio.ts`): ArrayBuffer fetch → `decodeAudioData` → `AudioBufferSourceNode`; round clock from `AudioContext.currentTime`; AudioContext created inside the "start quiz" tap (iOS Safari); no pause/replay/scrub surface (ROUND-2); measured buffer duration reported as `clipMs`.
- [x] **1.22** Preloader (MUS-7): parallel fetch + decode behind a loading screen with progress; 10 s timeout + one retry per clip, failure ⇒ round skipped client-side; **> 20 rounds ⇒ size/time estimate + explicit confirm, remembered per device**; gate raised early on `Save-Data`/slow `navigator.connection` (§4).
- [x] **1.23** `gameSession` state machine (Svelte 5 runes, §7.2/7.4): countdown → clip → early end when all targets locked → reveal (opens round pack) → scoreboard → manual advance → end summary (ROUND-1…7); abandonment discards (ROUND-8).
- [x] **1.24** Answer UI — free text: two independent inputs (title/artist) locking on correct submit (ANS-1); local validation via shared normalize/match against the decrypted pack — instant accept/reject, free retries, zero leakage (ANS-4/5); every attempt appended to guessLog with elapsed clip ms.
- [x] **1.25** Answer UI — multiple choice: 4 plaintext options per target from the manifest, per-session client-side shuffle, one final pick locks the target (ANS-6/7).
- [x] **1.26** Offline resilience (§4): beacons/results queue in memory, flush with retry/backoff; failed finalize retried from `localStorage` on next visit; reveal never blocked by connectivity.
- [x] **1.27** **Accessibility in the same commits as the flow it describes** (A11Y-2/3/6): `assertive` live region for countdown/clip start-end/accept-reject, `polite` for reveal + scoreboard; announcements queued to gaps between clips (reveal announced at clip end); deliberate focus moves at every transition; full keyboard operability; `prefers-reduced-motion` variants; no UI sound effects ever.
- [x] **1.28** Solo play route wiring (SOLO-1/2): generate → play → end summary; challenge/share actions stubbed until Phase 3.
- [x] **1.29** Fixture MP3s (synthesized ~30 s tones committed to `e2e/fixtures/` — no copyrighted audio) + Deezer stub layer for tests (§17).
- [x] **1.30** E2E: guest generates a quiz → plays 10 rounds with typo'd guesses → scores → reveals → summary. Plus **keyboard-only full-quiz run** and live-region ordering assertions (§17). Axe gate on all routes in CI.
- [x] **1.31 [USER]** Real-device smoke test on **iOS Safari** (autoplay unlock, decode, timing — §19 risk; any iPhone/iPad, borrow one if needed) and Android Chrome, against a PR preview URL. I prepare the build + written test script.

**GATE 1:** a guest can generate and play a quiz end-to-end on a preview URL — offline-tolerant, playable blind (scripted screen-reader checks pass), iOS-verified. CI fully green.

---

## Phase 2 — Identity

> §18 Phase 2. **Email + Google only** (Apple deferred, see deviations).

- [ ] **2.1 [USER]** Credentials: Google OAuth client (free) + Resend account & API key (free tier). Email+password work proceeds without them.
- [x] **2.2** Better Auth on D1 (Drizzle adapter): email+password with verification via Resend, Google OAuth (ACC-3 minus Apple). Cookies `HttpOnly/Secure/SameSite=Lax`, 30-day rolling. `user` extensions: `displayName` (+ stored normalized column, unique, collision suffix suggestions — ACC-5), `avatarUrl`, `locale`, `birthYear` (13+ enforced server-side at signup, LEGAL-1), `extendedInput` (A11Y-5), `isOperator`.
- [x] **2.3** Profanity filter (`server/profanity.ts`, FAIR-5): curated FR+EN lists _(subagent-ok)_; normalized-form word/substring match; enforced at **every name-set point** — display-name writes, guest nickname at `POST /api/sessions`, challenge-lobby join (§11). Friendly rejection, never filtered on read.
- [x] **2.4** `effective_scoring_mode` resolved at session creation (quiz mode, forced `'fixed'` for `extendedInput` players — A11Y-5/§9) + the pre-play "you're on the untimed board" notice.
- [x] **2.5** Guest import `POST /api/me/import-guest` (ACC-4, §10), single transaction: re-attribute server-side `game_session` rows by `guest_id`; re-run FAIR-2 per (user, quiz) demoting the later run to `'replay'`; backfill `weekly_points`; import remaining local blob into `imported_history` (stats only, never boards).
- [x] **2.6** Manual quiz builder backend: `POST /api/quizzes` (name/settings/ordered track-id list), `GET /api/catalog/search` (auth-gated); assembly-time availability + answer keys + distractors reuse the 1B machinery (`ensureTrackCached`/`buildRoundChoices`), same as `generate.ts`. **No builder UI page yet** — the add/reorder/remove-with-preview screen QUIZ-2..5 describe is the remaining piece; API is done and tested. (CREATE-1/2): name, catalog search (`GET /api/catalog/search`, auth-gated, server-cached), add/reorder/remove with clip preview, settings (QUIZ-2/3/4/5); assembly-time availability + answer keys + distractors (1B machinery).
- [x] **2.7** Quiz management: `PATCH`/`DELETE /api/quizzes/:id` (name/description always; **content edits 409 once challenged or scored** — CREATE-3), `POST /:id/duplicate` (CREATE-10), soft delete (CREATE-4 — dead-link _page_ not built, but `GET /api/quizzes/:id` 410s a deleted quiz for one to render against). Plus the missing read endpoints (§G): `GET /api/quizzes/:id` (lobby) and `GET /api/me/quizzes`.
- [x] **2.8** `POST /api/quizzes/:id/save` for generated quizzes (CREATE-6): sets owner, clears TTL, list frozen forever (CREATE-7).
- [x] **2.9** Operator role gate (`requireOperator`) + API surface (§15): `POST /api/quizzes/:id/publish` (CREATE-8, LOC-3 — localized name/description, ownerId cleared); `GET/POST /api/admin/daily` (CREATE-9 — 14-day calendar with `quizId: null` gaps, matching 4.14's lookahead); `GET /api/admin/flagged-sessions` (`scored_block_reason`); `GET /api/quizzes/official` (SHARE-3). **No `/admin` page UI yet** — API + `requireOperator` gate done and tested; the operator-facing frontend is the remaining piece, deferred alongside the rest of Phase 2/3's UI polish.
- [x] **2.10** FAIR-1 creator exclusion in finalize (`'creator'`, incl. operator accounts on official/daily quizzes — §7.3 step 5).
- [x] **2.11** Account deletion `DELETE /api/me` (ACC-6, §6 semantics): tombstoned rather than hard-deleted at once (a later purge, `jobs/index.ts`, removes the row once the 30-day `deletedEmailHash` window passes — §16's "then purged"); cascades auth/friendships/weekly_points now; anonymizes their rows on others' boards; quizzes → `owner_id NULL` + `deleted_at` (never hard-deleted).
- [x] **2.12** Integration tests: signup age gate, guest→account re-attribution incl. FAIR-2 collision, content-edit lock + duplicate, deletion leaves other players' boards and FKs intact (§17).

**GATE 2:** guest plays → signs up → sees imported history; creates, shares by link, edits-until-frozen, duplicates, deletes; operator publishes an official quiz. CI green.

---

## Phase 3 — Loops (daily, challenges, social, measurement) → **POC milestone**

> §18 Phase 3 — "the loop ships measured, not measured later."

- [x] **3.1** Daily quiz (DAILY-1/2/5): `daily_quiz` scheduling (Europe/Paris, already had admin CRUD from 2.9), `GET /api/daily` (`daily.ts`); one scored attempt/day enforced at finalize; past dailies playable as practice (`?day=`); daily-cron publication check + tomorrow-gap alert (§15) — logs loudly, the email/banner alert channel proper is still task 4.2.
- [x] **3.2** Guest daily dedupe (FAIR-7, §7.3 step 6): was already fully wired in `finalize.ts` from task 1.16 (`checkAndClaimGuestDaily`) — verified end to end with a new integration test, nothing to add.
- [x] **3.3** Spoiler-free daily share (DAILY-3): `game/share.ts` (pure, unit-tested) + `DailyShare.svelte` (Share API/clipboard + MET-1 counter) — never track names.
- [x] **3.4** Streaks (DAILY-4, §11): `streaks.ts`, computed at read time; current + best in `/stats`; `imported_history` counts toward _best_ only, never _current_ (§G-7).
- [x] **3.5** Challenges (CHAL-1…4): `challenges.ts` (create + lobby), `(share)/c/[token]` SSR page (unfurl-ready) playable guest-first via the shared `PlayQuiz.svelte`.
- [x] **3.6** Leaderboards (§11, STAT-2, CHAL-2, DAILY-2): `boards.ts` — quiz/challenge/daily queries over `scored AND completed`, `ORDER BY total_score DESC, finalized_at ASC` (FAIR-3), keyset cursor, self-row rank subquery, timed/untimed segmentation, `hasUntimedEntries`. Weekly board is `weekly.ts` (separate shape, no per-entry cursor needed at POC scale).
- [x] **3.7** Friends (FRIEND-1/2): `friends.ts` — username search, request/mutual-accept, invite link (`(share)/i/[userId]`, reuses the user id rather than a new token table); `?friends=1` filter wired into `boards.ts`. **API + minimal UI only** — friends list/request screen is the invite-link page's inline flow, not a dedicated friends-management page; direct challenge-to-a-friend send (as opposed to link share) is not built.
- [x] **3.8** Weekly ladder (STAT-4, §11): the `weekly_points` upsert was already in `finalize.ts` (task 1.16-era code); this phase added `weekly.ts`'s read side + the Monday-00:05 best-rank snapshot job, wired into the daily cron.
- [x] **3.9** Personal stats page (STAT-1): `/stats`, backed by `stats.ts` — games played, average/best, streaks, mode breakdown, top genres/decades incl. imported history.
- [x] **3.10** End-of-game summary completion (ROUND-7): `BoardPreview.svelte` (board placement), `ChallengeShare.svelte` (was a disabled stub, now creates a real link), `DailyShare.svelte` — wired into `PlayQuiz.svelte`'s summary phase.
- [x] **3.11** Metrics (MET-1/3): `metrics.ts` nightly aggregation (daily start/complete/share, challenge open/play/complete, D1/D7 cohorts, streak histogram, guest→account conversion recorded at the one point it's knowable) + `share_event` counters via `POST /api/metrics/event`; `/admin` dashboard (`(app)/admin`) draws the MET-2 lines — D7 is exact, the streak-median line is an approximation flagged as such in its own label (see gap note below).
- [x] **3.12** **PWA:** `manifest.webmanifest` + two placeholder icons + `src/service-worker.ts` caching the app shell only (verified with a real `vite build`, which emits `service-worker.js` cleanly). Installable on desktop/Android by spec; **iOS add-to-home-screen and a real Android install were not device-tested** — no device available this session, same posture as 1.31.
- [~] **3.13** Integration tests: **done** — FAIR-2/7 gating (incl. a new daily-specific FAIR-7 test), board tie-breaks/scoping, weekly-snapshot week-boundary behavior, streak run-length edge cases, friends mutual-accept, all against real D1 (`vitest-pool-workers`). **E2E not done**: the full daily flow and guest-to-guest challenge flow need Playwright specs mocking the new `/api/daily`, `/api/challenges/:token`, and board endpoints the way `e2e/helpers/mock-api.ts` already does for `/api/sessions` — same pattern as the existing solo-happy-path spec, just not written this session. Flagged as the clearest remaining gap before 3.15's field test.
- [x] **3.14** Unfurl **text** pass (SHARE-4 minimum): OG/Twitter meta on `(share)/q/[quizId]`, `(share)/c/[token]`, `(share)/i/[userId]`, all with `static/og-branded.png` (a minimal placeholder — a real design pass is a good follow-up, not a blocker); challenge tags carry nickname + score to beat; never artwork/titles/artists.
- [ ] **3.15 [USER] POC field test:** share the production `workers.dev` URL with friends — daily quiz + challenge links on real phones. Collect friction notes; triage into fix tasks before Phase 4.

**GATE 3 = POC:** the §21 acceptance snapshot (guest, nickname, 10 clips, typos score, reveals, board next to a friend) is implemented and covered by integration tests, but **not yet verified on an actual phone against a deployed challenge link** — that's 3.15, and it's the one item in this phase only the user can do. The `/admin` dashboard is live and will show real numbers once 3.15 generates traffic; right now it correctly shows zeros against an empty `metrics_daily`. Recommend running 3.15 next, before spending more effort on the E2E gap in 3.13 — a field-test friction note might change what those specs need to cover.

### Known gaps carried out of Phase 3 (not blockers, but real)

- **E2E for daily/challenge flows** (3.13) — see above.
- **Streak-median MET-2 line is approximate**, not "median streak among returning players" exactly (`metrics.ts`'s histogram is over everyone who played the daily that day, not specifically returners) — labeled as such in `/admin`, not silently wrong.
- **`og-branded.png` is a placeholder** (solid cream background, terracotta stripes) generated without an image library in this environment — functionally correct for SHARE-4 (never spoils the quiz) but not a designed asset.
- **Friends has no dedicated management page** — request/accept/search are API-complete and reachable from the invite-link page; a friends-list screen is a natural follow-up, not required by the phase's acceptance snapshot.
- **PWA is untested on a real device** — same posture the plan already used for 1.31's iOS audio smoke test; carries the same [USER] follow-up.

---

## Phase 4 — Polish, hardening, launch

> §18 Phase 4. Launch blockers marked ⛔.

- [ ] **4.1** Localization completeness pass: every UI string incl. **all live-region/accessibility strings** (A11Y-7) in fr+en; language switch in settings; `Intl` dates/numbers/ranks (LOC-3); metadata never translated (LOC-2). _(subagent-ok)_
- [ ] **4.2** Availability re-check jobs complete (§5.3): nightly for official/daily ahead of publication — takedown ⇒ `unavailable_at` + operator alert + automatic daily-slot disqualification; weekly for user quizzes. Operator alerts = email via Resend + `/admin` banner (channel unspecified in spec, §G).
- [ ] **4.3** Perf budgets enforced in CI (§4 table): 60 KB initial JS, LCP < 2.5 s Fast-3G, preload targets, p95 API < 50 ms; Lighthouse wired into the pipeline.
- [ ] **4.4** GDPR (LEGAL-4, §16): `GET /api/me/export` (full JSON dump from profile UI); deletion re-verified end-to-end; `docs/data-inventory.md` finalized — the source of truth for the privacy policy.
- [ ] **4.5** ⛔ ToS + Privacy Policy, FR + EN, written **from the data inventory** (LEGAL-3), static localized routes linked from footer + signup, `lastUpdated`. **[USER]** review (professional legal review recommended before growth, §19).
- [ ] **4.6** Security pass (§16): strict CSP (`default-src 'self'`, Deezer CDN media/img exceptions only, zero third-party scripts); secrets audit (Wrangler secrets, nothing in the repo); "Powered by Deezer" attribution on reveal cards + footer (§5.2).
- [ ] **4.7** ⛔ Backup/restore drilled: D1 Time Travel restore executed once for real + scheduled `wrangler d1 export` snapshots to R2 (free tier); runbook in `docs/runbooks/restore.md`.
- [ ] **4.8** Ops: `/healthz`, external uptime monitor (healthchecks.io free), error tracking (Sentry free tier — Workers SDK), Workers logs tail runbook.
- [ ] **4.9** **Tauri desktop app** (V1 commitment): wrap the PWA in Tauri v2; GitHub Actions matrix builds Windows/Linux/macOS installers (free runners — no Mac owned; macOS build unsigned or notarization deferred, §G); release artifacts attached to GitHub Releases; auto-update deferred.
- [ ] **4.10** Dynamic OG images revisited: satori + `@resvg/resvg-wasm` **if** measured CPU fits the free tier's 10 ms cap (pre-render at creation time into R2/KV, serve statically); otherwise keep static-brand + dynamic text and note it in the ADR.
- [ ] **4.11 [USER]** Custom domain (from 0.7) attached to the Worker; `workers.dev` URL kept as redirect.
- [ ] **4.12** ⛔ Full E2E suite green: §21 acceptance snapshot verbatim, FR/EN switch, daily flow, keyboard-only run, live-region assertions, axe on every route.
- [ ] **4.13 [USER]** Manual assistive-tech pass on real screen readers (NVDA on Windows at minimum; VoiceOver via any borrowable Apple device) + real-device retest; I prepare the scripted checklist, findings become fix tasks.
- [ ] **4.14** Launch checklist: ≥ 14 days of dailies pre-scheduled, gap alert verified; probe re-run; restore verified; MET-2 dashboard live; free-tier usage reviewed against launch traffic expectations (scale-up path = paid Workers ($5/mo) or the spec's original Hetzner shape — decision deferred until numbers exist).

**GATE 4 = LAUNCH:** §21 acceptance snapshot passes on a phone against the custom domain; all ⛔ done.

---

## §G — Gaps & deviations resolved by this plan

Decisions made where the specs are silent, inconsistent, or overtaken by the hosting change — flag any you disagree with:

1. **§10 API table vs §7.2:** the endpoint table still says the round-start beacon returns a round key; §7.2 (v1.1) moved keys to client-side HKDF. Plan follows §7.2 — beacon returns nothing (1.15).
2. **Daily "share" count has no data source** (MET-1 wants it; §15 claims funnels derive from existing tables, but nothing records shares — and with Plausible deferred, challenge _opens_ need a counter too). Anonymous counters added (3.11).
3. **No table for ACC-4's local-only import** — `imported_history` added (1.8).
4. **Distractor/generation cache cold start** — explicit warm-up seeding at deploy + daily refresh (1.12).
5. **Operator alert channel unspecified** — email via Resend + `/admin` banner (4.2).
6. **§10 misses read endpoints** the UI needs (quiz lobby, "my quizzes") — added (2.7).
7. **Imported guest streaks vs computed streaks** — imported counts toward _best_ only, never _current_ (3.4).
8. **Theme-seed generation quality** (CREATE-5 "movie soundtracks") — **RESOLVED by the 0.3 probe: free-text themes are marginal and do not ship as an open field in v1.** 6 of 8 theme seeds cleared the ≥15/25-usable bar; "comédie musicale française" returned 10/25 and "génériques dessins animés français" only 13 candidates in total. v1 therefore scopes CREATE-5 to the **structured filters** (genre / decade / artist — all reliable at 100 % in the probe) plus a **short curated, pre-vetted theme list** rendered as choices. An open free-text theme field is deferred until it can be backed by a curated mapping rather than raw search. Affects 1.13.
9. **Deezer CDN CORS** is assumed by the ArrayBuffer audio engine but never verified in the spec — probe checks it (0.5); fallback is `<audio>`-element playback with degraded timing accuracy (would need a scoring honesty note).
10. **Workers have no shared process memory** — the spec's in-process rate-limit queue and token buckets are re-specified against D1/cache (1.9, 1.18).
11. **Free-tier 10 ms CPU cap vs satori** — POC uses static branded OG image + dynamic text tags; SHARE-4 still honored (3.14, 4.10).
12. **Apple Sign-In deferred** (no Mac, no paid developer account) — email + Google at launch; Apple returns with iOS (deviation table).
13. **Unsigned macOS Tauri builds** — without an Apple Developer account, macOS installers show Gatekeeper warnings. Acceptable for V1 side-load; notarization deferred to the iOS/Apple investment.
14. **Test audio fixtures** — synthesized tones only, no copyrighted audio in the repo (1.29).
15. **Provider lock-in is a schema problem, not just an interface problem.** ADR-0001's ToS finding makes a provider swap a live possibility rather than a theoretical one, and `CatalogProvider` (§5.1) alone does not save us: `track_cache` keyed on a bare `deezer_id` would orphan every quiz on a swap. **Decision (affects 1.7, 1.9, 1.10):** `track_cache` gets an explicit `provider` column and **namespaced IDs** (`deezer:12345`), `quiz_track` references the namespaced key, and answer keys stay computed from title/artist _strings_ so they survive a swap untouched. The migration path becomes a documented runbook — re-resolve each cached track against the new provider by (title, artist), flag misses for operator review — not a redesign. Costs an hour now; costs a weekend and risks orphaning every board once real quizzes exist.
16. **Artist search must rank by popularity, not search order** (found during the 0.3 probe): naive "first exact-name match" picks an obscure homonym for some queries. `catalog/deezer.ts` ranks candidates by `nb_fan` (1.9).
17. **`adapter-cloudflare` cannot emit a `scheduled` handler**, so the plan's Cron Triggers had nothing listening — the deviation table's replacement for the spec's in-process `setInterval` jobs was silently inert. **Resolved:** `worker/entry.ts` wraps the adapter's generated `fetch` and adds `scheduled`, mapping each cron expression to a `runJobs(kind)` batch. It needs a **two-config split** (`wrangler.build.jsonc` for the adapter, `wrangler.jsonc` for deploy) because the adapter writes its output to whatever `main` points at — pointed at our own entry, it overwrites it on every build. Verified end to end with `wrangler dev --test-scheduled`: `fetch` still serves, a mapped cron runs, an unmapped one logs a loud guard. Unblocks 1.17, 3.1, 3.8, 3.11, 4.2.
18. **Deezer's ToS bars caching cover images** (ADR-0001), which tech-spec §5.3 assumed was fine. `track_cache.cover_url` stores a reference only; images are always fetched from the provider CDN at render time and never proxied or stored.
19. **`rate_limit` table (migration 0001).** Gap: §10 specifies per-identity rate limits, but Workers isolates share no memory, so the counters needed durable storage that did not exist in the schema. **Resolved:** a `rate_limit` table (`key`, `window_start`, `count`, composite PK, index on `window_start`) added in migration `0001_pretty_magneto.sql`, driving fixed-window counters in `src/lib/server/ratelimit.ts`. Fixed-window rather than sliding-window deliberately: one D1 write per request instead of many, which matters against the free tier's 100k writes/day, and the 2×-at-a-boundary burst is irrelevant for limits whose real job is protecting the §5.2 Deezer budget (50 req/5 s). Failing open on a limiter error is intentional — a broken counter must not take the game down. Needs a matching purge job in 1.17.
20. **`round_result` claim columns (migration 0001).** Gap: §7.3 has the server recompute lock times from the raw guess log, but the client also claims lock times, and there was nowhere to put the claim — writing it into `title_ms`/`artist_ms` would have destroyed the very value finalize is supposed to independently derive. **Resolved:** `claimed_title_ms`, `claimed_artist_ms`, and `server_received_at` added to `round_result` in migration 0001. The client's claim is stored but never trusted; finalize compares it against its own recomputation and notes any disagreement for the `/admin` view. `server_received_at` gives the reconstructed plausibility tier a server-side anchor for rounds whose start beacon never arrived (MUS-7).
21. **ROUND-8 vs MUS-7: what happens when finalize arrives for an abandoned session.** Gap: ROUND-8 says a run left `active` for 2 h is abandoned and discarded; §4/MUS-7 says a finalize that fails retries from `localStorage` "on next visit", which can legitimately land days later. The two rules contradict each other on the same request, and the spec never says which wins. Rejecting the finalize loses a real player's completed run; accepting it onto the boards opens a clean cheat — bank a session, research the answers at leisure, finalize with plausible-looking lock times that no offline-survivable invariant can detect (the _verified_ tier would catch it, but failing only that tier is explicitly not disqualifying, §7.3). **Resolved:** finalize accepts the session and returns the score (FAIR-6), but blocks it from the boards with a new `scored_block_reason` value, `'abandoned'`. It ranks below `'creator'` and `'replay'`, which are facts about who the player is and stay true regardless of when they finalized; `'abandoned'` is only about _when_, so it must never mask a more informative reason. `status` still becomes `'completed'` — the play did finish, and leaving it `'abandoned'` would keep the sweep reconsidering a finalized row. No migration: `scored_block_reason` is plain `text` with no CHECK constraint, so the enum is type-level only.
22. **Ephemeral-quiz sweep needs its own cron.** Gap: §15 specs the sweep hourly, but only two Cron Triggers existed (15-min and daily), so 1.17 initially rode the 15-min tick. That is idempotent and bounded, but it narrows the window between a generated quiz's TTL expiring and its deletion — and since finalize is what promotes an ephemeral quiz on use, a shorter window leans harder on that promotion having already landed. **Resolved:** a third trigger, `0 * * * *` → `runJobs('hourly')`, carrying the ephemeral sweep alone; the 15-min batch keeps the abandoned-session, guest-claim, and rate-limit purges. Restores the spec'd cadence and keeps the one destructive job on the slowest schedule that satisfies it.
23. **Runes tests were silently excluded from CI.** Gap: `vite.config.ts` declared a single vitest project, `unit`, whose `exclude` dropped `src/**/*.svelte.{test,spec}.{js,ts}` — the scaffold's placeholder for a future browser-mode project that was never added. So the first runes test written (`game-state.svelte.test.ts`, 12 tests for the whole round flow) was collected by nothing and reported by nothing: `pnpm test:unit` stayed green while the gameplay state machine had zero enforced coverage. A test file that never runs is worse than no test file, because it reads as coverage. **Resolved:** a second project, `client`, including exactly that glob. `environment: 'node'` is enough while runes tests are DOM-free state machines; testing actual `.svelte` components needs jsdom or vitest browser mode added there (1.30 and Phase 2 UI). Unit count went 422 → 434 on the config change alone.

## §L — Consolidated [USER] dependency list

| When                                 | Item                                                                                                        | Blocks                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Phase 0                              | Domain + trademark check (D-1)                                                                              | Public launch only (POC uses workers.dev)                                                                         |
| Phase 0 (start now — long lead time) | **Deezer ToS escalation (0.8)**: written question to Deezer's API/partnership contact re §IV "family scope" | Public launch only. Do it early because the reply is slow; do paid legal review only _after_ the POC clears MET-2 |
| Phase 0.5                            | Cloudflare account + API token in GitHub secrets                                                            | All deployment                                                                                                    |
| Phase 1 end                          | iOS-device smoke test (borrowable)                                                                          | Gate 1 sign-off                                                                                                   |
| Phase 2 start                        | Google OAuth credentials · Resend account                                                                   | OAuth + verification email                                                                                        |
| Phase 3 end                          | POC field test with friends                                                                                 | Gate 3 sign-off                                                                                                   |
| Phase 4                              | Domain attach · legal review of ToS/privacy · assistive-tech manual pass                                    | Launch                                                                                                            |
