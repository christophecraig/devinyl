# Devinyl — Technical Specification

**Status:** Draft v1.1 — 2026-08-03
**Companion document:** [functional-spec.md](./functional-spec.md) (draft v0.3). Requirement IDs (MUS-x, QUIZ-x…) referenced throughout are defined there.
**Scope:** full technical design for **V1**, plus the forward architecture for V2/V3 real-time modes. Design bias, per product direction: **as light and performant as possible** — one process, one file database, one cheap server, no heavy frameworks.

---

## 1. Stack summary

| Layer             | Choice                                                             | Rationale                                                                                                 |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Music catalog     | **Deezer public API**                                              | Free 30 s preview MP3s without user auth; strongest French repertoire (MUS-8); search + metadata included |
| Frontend          | **SvelteKit** (Svelte 5)                                           | Smallest bundles / fastest runtime of mainstream frameworks; SSR for link unfurling (SHARE-4)             |
| Backend           | **TypeScript on Node 22 LTS**, SvelteKit server endpoints          | One language, shared types + shared scoring/validation code between client and server                     |
| Database          | **SQLite** (better-sqlite3, WAL mode) + **Litestream** replication | Zero-ops, one file, microsecond queries; streaming backup to object storage                               |
| ORM / migrations  | **Drizzle ORM + drizzle-kit**                                      | Type-safe, SQLite-first, no runtime bloat                                                                 |
| Auth              | **Better Auth** (+ anonymous plugin)                               | Self-hosted, SQLite-backed, email + Google/Apple OAuth (ACC-3), guest→account upgrade path (ACC-4)        |
| i18n              | **Paraglide JS (inlang)**                                          | Compile-time messages, ~0 runtime cost, first-class SvelteKit adapter (LOC-1)                             |
| Audio             | **Web Audio API** (decoded buffers)                                | Precise clip timing for speed scoring; full pre-loading (MUS-7)                                           |
| Hosting           | **Hetzner VPS** (EU) + **Caddy** (TLS) + **Docker Compose**        | ~6 €/mo, full control, GDPR-friendly data locality                                                        |
| Real-time (V2/V3) | **WebSockets** in the same Node process                            | In-memory rooms; single-node model matches SQLite constraint                                              |

**Deployment shape:** a **single SvelteKit application** — UI and API in one repo, one Node process, one SQLite file. No monorepo, no microservices. Shared game logic (normalization, scoring) lives in `src/lib/game/` and is imported by both client and server code. Extraction into packages happens only if/when V2 demands it (§14).

> **V1 deployment note (2026-08-03):** V1 actually deploys on **Cloudflare Workers + D1**, not the Hetzner/Docker Compose shape in the table above — see [`docs/adr/0002-cloudflare-hosting.md`](./adr/0002-cloudflare-hosting.md) for the deviation table and rationale. D1 is the same SQLite dialect via Drizzle, so this row's schema/ORM design is unaffected; only the hosting/runtime/backup rows change. The VPS shape below remains the documented escape hatch and is intentionally left as-is.

---

## 2. Architecture overview

```
                        ┌────────────────────────── Hetzner VPS ─┐
 Browser (SvelteKit SPA │  ┌───────┐   ┌─────────────────────┐  │
 + SSR pages)           │  │ Caddy │──▶│ Node 22             │  │
   │  HTTPS             │  │ (TLS) │   │  SvelteKit app      │  │
   ├────────────────────┼─▶│       │   │  ├ UI (SSR + SPA)   │  │
   │                    │  └───────┘   │  ├ /api/* endpoints │  │
   │  30s preview MP3s  │              │  ├ ws (V2/V3)       │  │
   ▼                    │              │  └ better-sqlite3 ──┼──┼─▶ devinyl.db (WAL)
 Deezer CDN             │              └─────────────────────┘  │        │
 (audio never touches   │              ┌────────────┐           │        │
  our server)           │              │ Litestream │◀──────────┼────────┘
                        │              └─────┬──────┘           │
                        └────────────────────┼──────────────────┘
                                             ▼
                                   S3-compatible object storage
                                   (continuous WAL replication)
```

Key properties:

- **Audio never proxies through our server.** Clients fetch preview MP3s directly from Deezer's CDN. Our server only handles metadata, game state, and scores — it stays tiny.
- **Single writer node.** SQLite is embedded in the app process. All V1 traffic (and V2/V3's ~10-player rooms) is trivially within a single VPS's capacity; the write load is a handful of small rows per completed game session.
- **Stateless client sessions, stateful DB.** Game sessions are DB rows; the browser holds transient round state. V2/V3 room state is in-process memory (acceptable: rooms are ephemeral by nature, PARTY-5 rejoin is served from room memory).

---

## 3. Repository layout

```
blind-test/
├─ docs/                      # functional-spec.md, technical-spec.md, ADRs
├─ src/
│  ├─ lib/
│  │  ├─ game/                # SHARED client+server, pure functions, no I/O
│  │  │  ├─ normalize.ts      # answer normalization pipeline (§8.1)
│  │  │  ├─ match.ts          # fuzzy matching (§8.2)
│  │  │  ├─ scoring.ts        # point curves, versioned (§9)
│  │  │  └─ types.ts          # Quiz, Round, Session, GuessLog…
│  │  ├─ server/              # server-only
│  │  │  ├─ db/               # drizzle schema + migrations
│  │  │  ├─ catalog/          # Deezer client, cache, provider interface (§5)
│  │  │  ├─ auth.ts           # Better Auth instance
│  │  │  ├─ sessions.ts       # game-session lifecycle + re-validation (§7)
│  │  │  ├─ leaderboards.ts   # board queries (§11)
│  │  │  └─ profanity.ts      # FR+EN filter (FAIR-5)
│  │  ├─ client/              # audio engine, preloader, local guest storage
│  │  └─ i18n/                # paraglide messages (fr, en)
│  ├─ routes/
│  │  ├─ (app)/…              # play, create, browse, profile, stats
│  │  ├─ (share)/q/[id]/      # quiz link — SSR + OG tags
│  │  ├─ (share)/c/[token]/   # challenge link — SSR + OG tags
│  │  └─ api/…                # JSON endpoints (§10)
│  └─ hooks.server.ts         # auth guard, rate limiting, locale detection
├─ static/
├─ scripts/
│  └─ catalog-probe.ts        # MUS-8 go/no-go validation (§5.5)
├─ e2e/                       # Playwright
├─ Dockerfile · compose.yml · Caddyfile · litestream.yml
└─ package.json               # pnpm
```

Rule: **`src/lib/game/` is pure and isomorphic** — it is the single source of truth for validation and scoring, executed on the client for instant feedback and on the server as the authority (§7.3). It must never import server or browser APIs.

---

## 4. Frontend

- **SvelteKit with `adapter-node`.** SSR is enabled for shareable/landing routes (unfurl, SEO, fast first paint); the in-game experience runs as a client-side SPA after hydration.
- **Svelte 5 runes** for game state; no external state library. A single `gameSession` state machine drives the round flow (§7.2).
- **Styling:** vanilla CSS with custom properties (design tokens), no CSS framework. Mobile-first — the acceptance snapshot (§21 of the functional spec) is a phone browser. Colour tokens are defined to meet AA contrast in both themes at design time, so contrast is a property of the palette rather than something audited page by page (A11Y-6).
- **Accessibility** (§16 of the functional spec) — implementation notes, applied from Phase 1:
  - Semantic HTML first: real `<button>`, real `<form>`, real headings. ARIA only where no element exists.
  - The round flow drives an `aria-live="assertive"` region for countdown ticks, clip start/end, and accept/reject, and a `polite` region for the reveal and scoreboard (A11Y-2). Announcements are queued so nothing speaks over a playing clip (A11Y-3) — the reveal announcement fires on clip end, not on reveal-card mount.
  - Focus moves deliberately at every round transition (answer input on clip start, "next round" on reveal) and is never trapped. Visible focus ring is a token, not a browser default.
  - `prefers-reduced-motion` disables the countdown animation, score tickers, and position-change transitions; the information they convey is always present as text.
  - No UI sound effects anywhere in the game view (A11Y-3).
- **Audio engine** (`src/lib/client/audio.ts`):
  - Clips are fetched as `ArrayBuffer`s and decoded via `AudioContext.decodeAudioData` during the pre-round loading screen (MUS-7). Playback uses `AudioBufferSourceNode` — sample-accurate start, no `<audio>` element buffering stalls.
  - The round clock is derived from `AudioContext.currentTime` captured at `source.start()`, not `Date.now()` — immune to main-thread jank, which keeps speed scoring honest on slow devices.
  - iOS Safari constraint: the `AudioContext` is created/resumed inside the user's "start quiz" tap (autoplay policy).
  - A clip that fails to fetch or decode marks its round **skipped** client-side and is reported as skipped in the session result (MUS-5); the loading screen never blocks on a failed clip beyond a 10 s timeout + one retry. A session with any skipped round finalizes unscored (§7.3) and says so (FAIR-6).
  - Each round's decoded buffer duration is measured and sent with the round result; the scoring curve uses it rather than a hardcoded 30 s (§9), since preview lengths are not perfectly uniform.
- **Guest identity** (ACC-1): a `localStorage` blob holds `{ guestId (nanoid), nickname, history[], dailyStreak }`. Guests never touch the `user` table; their scores reference `guest_id + nickname` (§6). On signup, this blob is imported (ACC-4, §10 `POST /api/me/import-guest`).
- **Offline resilience** (MUS-7): all clips, the round manifest, **and every round decryption key** (derived locally from the session seed, §7.2) are in memory before round 1, so a connection drop mid-quiz never interrupts play and never blocks a reveal. Round-start beacons and round results queue in memory and flush with retry/backoff; a session finalize that keeps failing is retried from `localStorage` on next visit (scores post late rather than never — FAIR-3 ties break by completion time, which uses server receipt time, so late posting only hurts the late poster). A run played through a drop is still scorable — it falls to the reconstructed-timing tier of §7.3, not straight to unscored.

**Performance budgets** (enforced in CI via `vite build` size check + Lighthouse):

| Metric                                                | Budget                                                                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial JS (gzip, landing/play route)                 | < 60 KB                                                                                                                                                                                                         |
| LCP on Fast 3G, mid-range phone                       | < 2.5 s                                                                                                                                                                                                         |
| Clip preload, 10-round quiz (~480 KB/clip @128 kbps)  | ~5 MB, parallel fetch, progress bar; target < 8 s on 4G                                                                                                                                                         |
| Clip preload, 50-round quiz (the QUIZ-2 ceiling)      | ~24 MB, target < 40 s on 4G. Above 20 rounds the app shows estimated size + time and requires confirmation (MUS-7); the gate is also raised early when `Save-Data` or a slow `navigator.connection` is reported |
| Server p95 for any API endpoint                       | < 50 ms (SQLite makes this easy)                                                                                                                                                                                |
| axe-core violations (serious/critical) on every route | 0 — build fails otherwise (A11Y-1)                                                                                                                                                                              |

---

## 5. Catalog layer (Deezer)

### 5.1 Provider interface

Even though Deezer is the committed provider, all catalog access goes through one interface (`src/lib/server/catalog/provider.ts`) so a ToS change or shutdown is a bounded rewrite, not a redesign:

```ts
interface CatalogProvider {
	searchTracks(q: string, opts?: { limit?: number }): Promise<CatalogTrack[]>;
	getTrack(id: string): Promise<CatalogTrack | null>; // full metadata
	getPreviewUrl(id: string): Promise<string | null>; // fresh, short-lived
	radioForFilters(f: GenerationFilters): Promise<CatalogTrack[]>; // auto-generation pool (CREATE-5)
}
```

`CatalogTrack` = `{ providerId, title, titleShort, artists[], albumTitle, coverUrl, releaseYear, genre }` (MUS-2; decade derived from `releaseYear`).

### 5.2 Deezer specifics

- Public API, **no key required** for search/track/album/genre reads.
- Endpoints used: `/search/track?q=…` (creation search, MUS-3), `/track/{id}` (full metadata + `preview`), `/album/{id}` (genre + release date — search results omit both, so quiz creation triggers a track+album hydration), `/genre`, `/artist/{id}/top`, `/chart/{genreId}/tracks` and `/radio` (generation pools, distractor pools).
- **Rate limit: 50 requests / 5 s per source IP.** All Deezer calls are server-side (also avoids CORS), funneled through a small in-process queue that enforces the limit, with a 24 h TTL response cache for search queries and permanent metadata caching (below). The client never calls Deezer's API directly — only its CDN for MP3s.
- **Preview URLs expire.** Deezer's `preview` MP3 URLs carry a signed, time-limited token. Therefore: **we never store preview URLs.** We store Deezer track IDs; at game-session start the server resolves fresh preview URLs for the whole quiz in one batch and returns them in the session manifest (§7.1). A track whose preview has disappeared (catalog churn) is marked unavailable at manifest time → round skipped (MUS-5) and flagged for quiz-owner attention.
- **ToS posture:** metadata caching + linking previews from Deezer's CDN with attribution; **no audio is stored or proxied**. A "Powered by Deezer" attribution appears on reveal cards and in the footer. _(Action: re-read the Deezer API ToS at implementation start and record the conclusion as an ADR — same footing as D-1.)_

### 5.3 Metadata cache

Table `track_cache` (§6) stores everything the app needs to run a quiz **without further Deezer calls**: title, short title, artist list, album, cover URL, release year, genre, plus `fetched_at`. Consequences:

- Playing a quiz costs **one** Deezer round-trip (batch preview-URL resolution), regardless of player count — the daily quiz at peak load barely registers against the rate limit.
- Cover URLs are Deezer CDN URLs (long-lived, unlike previews); if one 404s the client falls back to a placeholder.
- A **nightly** job refreshes `track_cache` rows referenced by official and daily quizzes and re-checks preview availability. A detected takedown stamps `unavailable_at`, alerts the operator, and disqualifies the affected quiz from being served as that day's daily — MUS-5 makes a mid-day takedown expensive (every session touching it goes unscored), so detection has to run ahead of play, not after it. User quizzes are re-checked weekly.

### 5.4 Answer keys

At quiz-assembly time (manual add, generation, or official curation) the server computes and stores per-track **accepted answers** (§8): normalized title (from `title_short`, which already drops most parenthetical noise), normalized full title, and normalized name of every credited artist with the primary artist flagged (ANS-3). This happens once, at creation — round validation never string-processes raw Deezer data at play time.

Assembly is also where **availability is enforced** (MUS-5): adding a track resolves its preview URL and requires HTTP 200 with a plausible duration. A track that fails is refused at add time with a message to the creator, so a quiz can never be saved or published containing a known-dead clip.

### 5.5 MUS-8 go/no-go probe

`scripts/catalog-probe.ts` runs **before any other implementation work**:

- Input: a curated list of ~100 French-repertoire probes across chanson, pop, rap, both catalog classics and current hits (Goldman, Brel, Stromae, Angèle, Orelsan, Aya Nakamura, …), each as (artist, expected-track) pairs plus artist-only searches.
- For each: search Deezer, verify the expected track is found, has a working `preview` URL (HTTP 200, ~30 s duration), and carries usable genre + release-date metadata via album hydration.
- **Pass criterion: ≥ 95 % of probes yield a playable, correctly-attributed preview.** Output is a markdown report committed to `docs/`. Failure = stop and re-open the provider decision before writing app code.

---

## 6. Data model (SQLite)

WAL mode, `foreign_keys=ON`, `busy_timeout=5000`. IDs are `nanoid(12)` strings unless noted. Timestamps are integer Unix ms, UTC. Drizzle schema in `src/lib/server/db/schema.ts`; migrations via drizzle-kit, applied on boot.

**Auth (owned by Better Auth):** `user`, `session`, `account`, `verification` — standard Better Auth SQLite tables. `user` is extended with `displayName` (unique, case/diacritic-insensitive via a stored normalized column — ACC-5), `avatarUrl`, `locale`, `birthYear` (13+ check at signup, LEGAL-1 — year only; a full date is more personal data than the check needs), `extendedInput BOOL` (A11Y-5), and `isOperator BOOL` (§15).

**Application tables:**

```
track_cache      deezer_id PK · title · title_short · artists JSON [{name, primary}]
                 · album_title · cover_url · release_year · genre · answers JSON (§5.4)
                 · fetched_at · unavailable_at NULL

quiz             id PK · owner_id FK user NULL · kind ('manual'|'generated'|'official'|'daily')
                 -- officiality is decided by `kind`, never by owner_id: NULL owner means
                 -- "operator-owned" for official/daily, and "owner deleted their account"
                 -- otherwise (ACC-6, deletion semantics below)
                 · name · description NULL
                 · name_fr · name_en · description_fr · description_en   -- kind IN ('official','daily') (LOC-3)
                 · guess_target ('both'|'title'|'artist')   (QUIZ-3)
                 · answer_mode ('text'|'choice')            (QUIZ-4)
                 · scoring_mode ('speed'|'fixed')           (QUIZ-5)
                 · choice_retry_mode ('oneShot'|'penalty')   (QUIZ-7, ANS-7/8; meaningful only when answer_mode='choice')
                 · choice_retry_penalty_seconds INT 0-10     (QUIZ-7, ANS-8; used only when choice_retry_mode='penalty')
                 · curve_version INT                        (SCORE-6)
                 · ephemeral_until INT NULL                 -- generated-but-unsaved TTL (CREATE-5/6)
                 · created_at · updated_at · deleted_at NULL (CREATE-4: soft delete)

quiz_track       quiz_id FK · position INT · deezer_id FK track_cache
                 · choices JSON NULL      -- 4 options per target, fixed at creation (ANS-6, QUIZ-6)
                 PK (quiz_id, position)

daily_quiz       day DATE PK (Europe/Paris calendar) · quiz_id FK · day_number INT UNIQUE

challenge        token PK (nanoid 10, unguessable) · quiz_id FK
                 · creator_user_id NULL · creator_guest_nickname NULL · created_at

game_session     id PK · quiz_id FK · challenge_token FK NULL · daily_day NULL
                 · user_id FK NULL · guest_id NULL · nickname          -- exactly one identity
                 · status ('active'|'completed'|'abandoned')
                 · scored BOOL            -- first completed run for this player+quiz(+challenge) (FAIR-2)
                 · scored_block_reason TEXT NULL
                   -- 'replay' | 'creator' | 'clip_unavailable' | 'unverified_timing' | 'implausible'
                   -- drives both the player-facing message (FAIR-6) and the /admin view (§15)
                 · curve_version INT
                 · effective_scoring_mode ('speed'|'fixed')
                   -- quiz.scoring_mode, forced to 'fixed' when the player has
                   -- extendedInput (A11Y-5). Boards segment on this column.
                 · total_score INT NULL · started_at · finalized_at NULL
                 · server_round_log JSON  -- server timestamps per round-start beacon (§7.3)

round_result     session_id FK · position INT
                 · title_ok BOOL NULL · artist_ok BOOL NULL · skipped BOOL
                 · clip_ms INT            -- measured buffer duration, curve denominator (§9)
                 · title_ms INT NULL · artist_ms INT NULL   -- elapsed clip time at lock-in
                 · points INT · guess_log JSON              -- every raw attempt + timestamp (§7.3)
                 PK (session_id, position)

friendship       a_user_id FK · b_user_id FK · status ('pending'|'accepted')
                 · requested_by FK · created_at · PK (a_user_id, b_user_id), a < b

weekly_points    user_id FK · week TEXT ('2026-W32') · points INT · PK (user_id, week)   (STAT-4)

daily_guest_claim day DATE · ip_hash TEXT · guest_id · created_at · PK (day, ip_hash)   (FAIR-7)
                 -- ip_hash = HMAC(server_secret ‖ day, ip): day-salted, so values are
                 -- unlinkable across days. Purged after 48 h (§15 sweep, §16 inventory).
```

**Quiz content is immutable once public (CREATE-3).** A content edit (`quiz_track` rows, or the `guess_target`/`answer_mode`/`scoring_mode` settings) is refused once `EXISTS(challenge WHERE quiz_id = …)` or `EXISTS(game_session WHERE quiz_id = … AND scored)`; the creator duplicates instead (CREATE-10). Name and description stay editable. This is why there is no `board_epoch` anywhere: epochs existed to reset a board after an edit, and an edit can no longer happen once a board exists.

**Ephemeral quizzes.** `POST /api/quizzes/generate` writes a real row (`kind='generated'`, `owner_id` NULL, `ephemeral_until = now + 24 h`) — `game_session.quiz_id` is a real FK, so generated quizzes are never merely in-flight objects. Saving it (CREATE-6) sets `owner_id` and clears the TTL. **Promotion on use:** creating a challenge from it, or finalizing any scored session on it, clears `ephemeral_until` unconditionally — a guest's challenge link must not evaporate out from under its own board. The sweep (§15) therefore only ever deletes leaf rows.

**Leaderboards are queries, not tables** (§11) — `game_session WHERE scored AND status='completed'` with indexes:

- `idx_gs_board (quiz_id, effective_scoring_mode, scored, total_score DESC, finalized_at)`
- `idx_gs_challenge (challenge_token, effective_scoring_mode, scored, total_score DESC, finalized_at)`
- `idx_gs_daily (daily_day, effective_scoring_mode, scored, total_score DESC, finalized_at)`
- `idx_gs_player (user_id, quiz_id)` and `(guest_id, quiz_id)` — FAIR-2 first-run check

At V1 scale (even 10⁵ sessions) these are sub-millisecond in SQLite. No caching layer; revisit only with evidence.

**Deletion semantics:** account deletion (ACC-6) hard-deletes the `user` row (cascading auth tables, friendships, `weekly_points`) and anonymizes the deleted user's `game_session` rows on _other_ people's boards (`user_id → NULL`, nickname → "deleted player").

Their **quizzes are never hard-deleted**: `owner_id → NULL` and `deleted_at` is stamped — precisely the CREATE-4 soft-delete state, so links resolve to a friendly "this quiz is no longer available" rather than 404, and third parties' `game_session` rows keep a valid `quiz_id` FK instead of being cascaded away with someone else's account. Hard-deleting the quiz rows would have taken other players' scores and history with them.

---

## 7. Game engine

### 7.1 Session lifecycle

```
POST /api/sessions  { quizId | challengeToken | daily: true }
  └▶ server: resolve quiz, create game_session(status=active),
     batch-resolve fresh preview URLs (§5.2),
     build MANIFEST:
       rounds[]: { position, previewUrl, choices? }        ← no answer metadata
       answerPack: encrypted blob (§7.2)
       sessionSeed: round-key material (§7.2)
       settings, curveVersion, sessionId
```

The manifest deliberately contains **zero plaintext answer data** (MUS-4). Reveal data (title, artist, artwork — ROUND-4) is inside the encrypted per-round pack, opened only at reveal time.

Client then: preload all clips → loading screen (MUS-7) → rounds (§7.2) → finalize.

```
POST /api/sessions/:id/rounds/:n/start     -- beacon; server records its own timestamp.
                                           -- Fire-and-forget: nothing on the play path waits
                                           -- for it, and a failed beacon queues client-side.
POST /api/sessions/:id/rounds/:n/result    -- { guessLog, lockTimes, clipMs, skipped, queuedBeacons? }
POST /api/sessions/:id/finalize            -- server re-validates & scores (§7.3), returns
                                           -- authoritative totals + board placement (ROUND-7)
```

Abandonment (ROUND-8): sessions with `status='active'` older than 2 h are swept to `abandoned` by a periodic job; abandoned sessions never score.

### 7.2 Hybrid validation — client side (instant feedback)

Per the hybrid decision: the client validates locally for zero-latency feedback (ANS-4), and the server re-validates everything before any score exists (§7.3).

- The manifest's `answerPack` is the per-round accepted-answers + reveal metadata, AES-GCM-encrypted with a per-round key. Round _n_'s key is **derived client-side** as `HKDF(sessionSeed, n)`, with `sessionSeed` delivered in the manifest. Keys therefore never touch the network during play, and neither validation nor reveal can be blocked by a connection drop (MUS-7).
  - This is obfuscation, not security: anyone can derive all the keys up front. That is fine and always was — §7.2's earlier per-round-key delivery was equally derivable in its offline fallback. FAIR-4 concedes determined cheaters exist; the _authoritative_ defense is server re-validation (§7.3), and coupling key delivery to the beacon bought nothing while making the beacon load-bearing for gameplay.
- On each keystroke-submit, the client runs the **shared** `normalize()` + `match()` (§8) against the decrypted round answers → immediate accept/reject UI, no network round-trip, no "close!" leakage (ANS-5 — the UI only ever shows accept or reject).
- Every attempt (raw string, elapsed clip ms from the audio clock) is appended to `guessLog`. Correct submissions lock their target (ANS-1) and record `lockTimes`.
- Multiple choice (ANS-6/7/8): the 4 options come plaintext in the manifest (they don't leak the answer); every pick and its timestamp go in `guessLog`; correctness is still only confirmed via the round pack / server. Whether a wrong pick ends the target (one-shot) or reopens it after `choice_retry_penalty_seconds` (penalty retry) is purely a client input-gating rule (§7.4) — it changes nothing about what gets scored, since scoring only ever reads `lockTimes` for the eventual correct pick (§9).

### 7.3 Hybrid validation — server side (authority)

At `finalize`, the server recomputes the entire session from raw inputs, using the **same shared code**:

1. Re-run `normalize()`/`match()` on every `guessLog` attempt against `track_cache.answers`. The client's claimed correctness is ignored — only recomputed results count.
2. Recompute points from `lockTimes` with the quiz's `curve_version` and the round's reported `clipMs` (§9).
3. **Plausibility checks**, in two tiers, because MUS-7 explicitly promises play survives a connection drop — and a drop means the round-start beacons never arrived. Punishing that would make the offline guarantee a trap.
   - **Verified** — `server_round_log` holds a server-observed beacon for the round: claimed elapsed time must fit inside the window between that beacon and the result POST (+2 s network tolerance).
   - **Reconstructed** — the beacon arrived late (flushed with the result) or only at finalize: fall back to invariants that survive offline play — timestamps monotonic, every `lockTime` within `[0, clipMs]`, rounds in order, and `finalized_at − started_at ≥ Σ` claimed round durations.
   - `clipMs` itself is checked against the server's known preview duration for that track (±2 s), so it can't be inflated to buy a gentler curve.
4. A session is `scored=false` with `scored_block_reason` when: any round is `skipped` (`'clip_unavailable'`, MUS-5), the reconstructed tier fails (`'implausible'`), or no timing evidence exists at all (`'unverified_timing'`). Failing only the _verified_ tier is not itself disqualifying. In every case the player sees their score with a plain explanation (FAIR-6) — connectivity and dead-clip reasons are stated honestly; `'implausible'` is shown as a generic "couldn't be verified", never an accusation (FAIR-4 posture).
5. First-run check (FAIR-2): `scored=true` only if no prior scored session exists for this (player, quiz [, challenge | daily]) — otherwise `'replay'` and the run is labeled _practice_ in the response. Creator check (FAIR-1): `'creator'` for the quiz owner on their own quiz, and for any account carrying the `operator` flag on `kind IN ('official','daily')` quizzes — the operator curates those and has heard the answers just as a creator has.
6. Guest daily dedupe (FAIR-7): for a guest finalizing a daily session, insert into `daily_guest_claim`; a PK conflict from a _different_ `guest_id` means the local ID was reset, and the session is stored `scored=false, 'replay'`. Coarse by design — it fails open toward letting people play.
7. Weekly ladder credit (STAT-4): scored daily/official sessions upsert into `weekly_points` (ISO week, Europe/Paris) per the formula in §11.

This keeps casual forgery off the boards while paying **zero latency** during play and keeping the server code small — it's the same pure functions run twice.

### 7.4 Round flow timing

- Pre-round 3-2-1 (ROUND-1) is client-local.
- Clip plays once, no pause/replay/scrub (ROUND-2) — the audio engine exposes no such controls.
- Early round end when every required target is **settled** (ROUND-3) — correctly answered, or (choice mode, one-shot retry policy, ANS-7) answered wrong and thereby exhausted; otherwise ends at buffer end. Choice mode's penalty-retry policy (ANS-8) never settles a target on a wrong pick, so it always falls through to buffer end unless answered correctly first.
- Reveal (ROUND-4) opens the round pack; scoreboard (ROUND-5) is local running state; advance is manual (ROUND-6).

---

## 8. Answer normalization & matching (ANS-2)

All in `src/lib/game/` — pure, isomorphic, exhaustively unit-tested. This module is the heart of the "type guesses with typos and still score" acceptance criterion.

### 8.1 `normalize(s: string): string`

Pipeline, in order:

1. Unicode NFKD → strip combining marks (accents), `ß→ss`, `œ→oe`, `æ→ae`.
2. Lowercase.
3. Strip parenthetical/bracketed segments and trailing dash-suffixes: `(remastered 2011)`, `[live]`, `- radio edit` — applied when computing _accepted_ answers (so the core title is enough) **and** to player input (so typing the suffix also works).
4. Strip featuring segments: `feat.`, `ft.`, `featuring`, `avec` + everything after.
5. Replace `&` → `and` / `et` (both accepted via variants), `+` → `and`.
6. Strip all punctuation/apostrophes; collapse whitespace.
7. Strip leading articles: `the, a, an, le, la, les, l, un, une, des, du, de, d`.
8. Digit/word folding for small numbers: accepted answers are stored in both forms where applicable (`99 luftballons` / `neunundneunzig…` is out of scope; only `1↔one/un` … `10↔ten/dix`).

### 8.2 `match(input, accepted[]): boolean`

- Exact match on normalized forms first (covers the huge majority).
- Otherwise **Damerau-Levenshtein** (transpositions count as 1) against each accepted form, with a length-scaled threshold on the accepted form:

| normalized length | max distance |
| ----------------- | ------------ |
| 1–3               | 0            |
| 4–6               | 1            |
| 7–10              | 2            |
| ≥ 11              | 3            |

- Accepted forms per track (precomputed, §5.4): normalized `title_short`, normalized full title, and per guess-target artist: normalized name of **each** credited artist (any one suffices; primary not required beyond ANS-3's guarantee).
- Property tests (fast-check) assert: every accepted form matches itself; random ≤-threshold mutations match; clearly-different real titles from the probe list don't cross-match.

### 8.3 Distractor generation (ANS-6)

At quiz assembly, per round and per guess target: draw a candidate pool, filter to same decade where possible, drop candidates whose normalized form matches the correct answer or another chosen distractor, pick 3 at random, **store them in `quiz_track.choices`** — fixed forever so every player of the quiz sees identical options in identical (per-player shuffled) order (QUIZ-6 fairness: shuffle order client-side per session, content fixed).

**The pool is cached, not fetched live.** Distractors needed a Deezer call per round per target, which is fine for a curated quiz assembled once but not for a guest generating a 10-round choice quiz on the interactive path — that is dozens of calls against a 50-req/5-s shared-IP budget, and it would falsify §5.3's "one round-trip per play". So candidates are drawn from `track_cache`, indexed by `(genre, decade)` and populated by the same chart/related-artist calls run in the background (generation pools, cache warm-up, nightly refresh). Live calls happen only when a `(genre, decade)` bucket is too thin to yield 3 clean distractors.

---

## 9. Scoring (§9 functional)

`src/lib/game/scoring.ts`, versioned — `curve_version` is stamped on quiz and session (SCORE-6); changing a curve means adding `v2`, never editing `v1`.

**Curve v1:**

- **Speed mode (SCORE-2):** per correct target, `points(tMs) = max(100, round(1000 − 900 × min(tMs, clipMs) / clipMs))` — linear 1000 → 100 across the clip. The denominator is the round's **measured** buffer duration (`round_result.clip_ms`), not a hardcoded 30 000: Deezer previews are nominally 30 s but not uniformly so, and a hardcoded denominator would quietly hand a slightly-short clip a steeper curve than its neighbours.
- **Fixed mode (SCORE-3):** 500 per correct target.
- **Which mode applies** is `game_session.effective_scoring_mode`, resolved once at session creation: the quiz's `scoring_mode`, forced to `'fixed'` if the player has `extendedInput` set (A11Y-5). Resolving it at creation rather than at finalize means the player is told which board they are playing for _before_ they play, and a mid-session settings change can't retroactively move their run.
- Unanswered/incorrect target: 0; skipped round (MUS-5): excluded from totals and displayed as "—" (no penalty), and the session does not score at all (§7.3 step 4).
- Round score = sum of targets (SCORE-1); quiz total = sum of rounds (SCORE-5).

---

## 10. API surface

SvelteKit `+server.ts` endpoints under `/api`. JSON bodies validated with zod at the boundary; shared zod schemas live beside the shared types. Auth context injected in `hooks.server.ts` (Better Auth session, or `x-guest-id` header for guests).

```
Catalog        GET  /api/catalog/search?q=            (auth: creator, MUS-3; server-cached)
Quizzes        POST /api/quizzes                       create manual (CREATE-1, auth)
               PATCH/DELETE /api/quizzes/:id           name/description always; content edits
                                                       409 once challenged or scored (CREATE-3)
               POST /api/quizzes/:id/duplicate         fresh copy, empty board (CREATE-10)
               POST /api/quizzes/generate              filters ⇒ quiz w/ 24 h TTL (CREATE-5, guests ok)
               POST /api/quizzes/:id/save              persist a generated quiz (CREATE-6, auth)
               GET  /api/quizzes/official              official catalog (CREATE-8)
Sessions       POST /api/sessions                      manifest (§7.1)
               POST /api/sessions/:id/rounds/:n/start  beacon → round key
               POST /api/sessions/:id/rounds/:n/result
               POST /api/sessions/:id/finalize         authoritative score + placement
Challenges     POST /api/challenges                    from a completed session (CHAL-1)
               GET  /api/challenges/:token             lobby data: challenger, score to beat
Daily          GET  /api/daily                         today's state for this player (DAILY-1/2)
Boards         GET  /api/boards/quiz/:id · /challenge/:token · /daily/:day · /weekly
               (?friends=1 filter, STAT-3; cursor pagination)
Social         POST /api/friends/requests · PATCH /api/friends/requests/:id
               GET  /api/friends · GET /api/players/search?q=      (FRIEND-1)
               POST /api/friends/invites               ⇒ token; SSR route (share)/i/[token]
                                                       with the same branded OG card (FRIEND-1, SHARE-4)
Me             GET  /api/me/stats (STAT-1) · POST /api/me/import-guest (ACC-4)
               PATCH /api/me/settings                  locale, extendedInput (A11Y-5)
               GET  /api/me/export (LEGAL-4) · DELETE /api/me (ACC-6)
```

**Rate limiting** (in-process token buckets keyed by IP + identity, no Redis): catalog search 30/min; session creation 10/min; finalize 20/min; auth endpoints per Better Auth defaults. 429 with `Retry-After`.

**Guest import (ACC-4):** the client posts its local history blob _and its `guestId`_. In one transaction the server:

1. **Re-attributes server-side scores** — `UPDATE game_session SET user_id = ?, guest_id = NULL WHERE guest_id = ?`. A guest who played the daily and then signed up keeps their row on that board and their weekly-ladder credit instead of losing both at the moment they commit to an account.
2. Re-runs the FAIR-2 first-run check per (user, quiz): if the account already holds a scored run for a quiz, the earlier `finalized_at` stays scored and the other is demoted to `'replay'`.
3. Backfills `weekly_points` for the re-attributed sessions' ISO weeks.
4. Imports the remaining **local-only** entries as historical stats (marked `imported=true`) feeding STAT-1 and streaks. These never enter leaderboards — they were never server-validated.

---

## 11. Leaderboards & stats

- **Per-quiz / challenge / daily boards (STAT-2, CHAL-2, DAILY-2):** single indexed query over `scored AND status='completed'`, `ORDER BY total_score DESC, finalized_at ASC` (FAIR-3 tie-break), cursor-paginated top-50 + "your row" via a rank subquery (SQLite window functions). No epoch predicate — quiz content is frozen once a board exists (§6), so every row on a board was produced by the same tracks in the same order.
  - **Two boards per speed-scored quiz** (A11Y-5): every board query filters `effective_scoring_mode`, and the UI shows a **Timed / Untimed** toggle on speed quizzes (fixed-mode quizzes have one board and no toggle). A player with `extendedInput` lands on the untimed board by default and is told so before starting. Same index, one extra equality column — the untimed board costs nothing until someone uses it.
- **Friends filter (STAT-3):** same query `JOIN friendship` on accepted pairs + self.
- **Weekly ladder (STAT-4):** `weekly_points` summed per ISO week (Europe/Paris), reset is implicit (new week key). A row in personal stats records best weekly rank, snapshotted by a Monday-00:05 job before the old week goes cold.
  - **Contribution formula:** each scored daily or official session contributes `round(100 × total_score / max_possible_score)`, weighted **×2 for the daily**. Normalizing by the quiz's maximum keeps a 5-round daily comparable to a 20-round official quiz, and FAIR-2 already caps each quiz at one contribution per player, so the ladder measures accuracy-and-speed rather than sheer volume. The 100-point scale and the daily's ×2 are tunable constants — like `curve_version`, changing them mid-week would distort a live board, so they change only at a week boundary.
- **Daily streaks (DAILY-4):** computed from the player's scored daily sessions at read time (max ~365 rows/player/year — no denormalized counter to corrupt); current + best cached in the stats response.
- **Profanity filter (FAIR-5):** normalized-form (§8.1) substring/word match against a curated FR+EN list, applied at every point a name is _set_: account display-name write, **`POST /api/sessions` for a guest nickname, and challenge-lobby join**. Guests have no account write to hook, so filtering only on the account path would have left the daily board — the most public surface in the product — unfiltered. Reject with a friendly message, never on read.

---

## 12. Auth (Better Auth)

- Providers (ACC-3): **email+password** (with email verification via an SMTP relay — Scaleway TEM or Postmark, EU region) and **Google + Apple** OAuth. Apple is required later anyway for iOS; wiring it now avoids account-linking pain.
- **Anonymous plugin** is _not_ used for guests (guests are deliberately server-invisible until they score, §4); it's evaluated only as an alternative import path if the local-blob import proves fragile.
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day rolling.
- Display-name uniqueness (ACC-5): unique index on the normalized column; suffix suggestions on collision.

## 13. Localization, sharing, unfurl

- **Paraglide** messages `fr`/`en`; locale = URL-independent, detected from `Accept-Language`, persisted per profile/localStorage, switchable in settings (LOC-1). Metadata always verbatim (LOC-2); `Intl` for dates/numbers/ranks (LOC-3).
- **Unfurl (SHARE-4):** `/q/[id]`, `/c/[token]` and `/i/[token]` are SSR pages with OG/Twitter meta. Per SHARE-4, share cards never show track artwork, titles, or artists. Each link gets a **dynamically rendered OG image** (`/api/og/[...]` — satori + resvg-js, pure TS, no headless browser): app branding + quiz name + round count, and for challenges the challenger's nickname and score to beat. Images are cached immutably per (quiz, `updated_at`) / (challenge, top-score bucket). Daily result share (DAILY-3) is a generated text block (score, day number, per-round emoji row) via the Share API / clipboard.
- **Legal pages (LEGAL-3):** `/terms` and `/privacy` are static localized routes, linked from the footer and the signup form, with a `lastUpdated` date. They are content, not boilerplate — the privacy policy is written from §16's data inventory and must be re-read whenever that inventory changes.
- Official quiz names/descriptions: localized columns on the quiz row (`name_fr`, `name_en`, `description_fr`, `description_en`, §6) for `kind IN ('official','daily')`.

---

## 14. Real-time forward plan (V2/V3)

Designed now so V1 decisions don't paint us into a corner; **implemented later.**

- **Transport:** WebSockets on the same Node process (`ws` attached to adapter-node's HTTP server). No Socket.IO — a thin JSON protocol `{type, roomCode, payload}` with a heartbeat is enough for ~10-player rooms (PARTY-3, ONLINE-3).
- **Rooms:** in-memory `Map<roomCode, Room>`; `Room` holds the quiz snapshot, member list (with scores), and round state machine. Single-node SQLite already forces one app node, so in-memory rooms cost nothing extra. Rejoin (PARTY-5) = reattach by `playerToken` kept in the phone's localStorage; rooms survive individual sockets.
- **V2 (party):** host screen owns audio + display; controllers only send guesses — bandwidth is trivial. Host messages: start/skip (PARTY-4); server round clock is authoritative for speed scoring.
- **V3 (online sync, ONLINE-3):** server broadcasts `startAt` (server time); clients estimate clock offset via 5-ping median and schedule `source.start()` on their audio clock. Target skew < 100 ms — well inside speed-scoring fairness given the 900-points-over-30 s curve (±100 ms ≈ ±3 pts).
- **Extraction trigger:** only if a single node ever caps out do we split a room server (rooms are stateless with respect to SQLite until the final score write, so extraction is clean).

---

## 15. Infrastructure & operations

> **V1 deployment note (2026-08-03):** the section below describes the spec's original Hetzner/Docker/Litestream target shape. **V1 actually runs on Cloudflare Workers + D1** per [`docs/adr/0002-cloudflare-hosting.md`](./adr/0002-cloudflare-hosting.md), which reproduces this section's server/runtime/deploy/backup/jobs/metrics rows with their Workers-native equivalents (Cron Triggers, D1 Time Travel, Wrangler/GitHub Actions, Resend, deferred Plausible) and records the rationale, free-tier limits, and consequences for each substitution. This section is kept intact as the documented escape hatch — see the ADR's "Escape hatch" section for what returning to it costs.

- **Server:** Hetzner CX22-class VPS (2 vCPU / 4 GB, ~6 €/mo), Falkenstein or Helsinki. Ubuntu LTS, unattended-upgrades, SSH keys only, ufw (80/443/22).
- **Runtime:** Docker Compose — four containers: `caddy` (TLS, HTTP/3, compression, static caching), `app` (Node), `litestream` (sidecar replicating `devinyl.db` to S3-compatible object storage — Hetzner Object Storage or Backblaze B2), `plausible` (self-hosted analytics, below). Shared volume for the DB.
- **Deploy:** GitHub Actions → build image → push to GHCR → SSH `docker compose pull && up -d`. Migrations run on app boot (drizzle-kit), guarded by a single-writer startup lock. Rollback = redeploy previous tag (migrations are additive-only between releases).
- **Backups:** Litestream continuous WAL shipping (RPO ≈ seconds) + nightly full snapshot generation, 30-day retention. **Restore is drilled**: a documented `litestream restore` runbook, tested before launch.
- **Jobs** (in-process `setInterval`, no external scheduler): session sweep (§7.1); daily-quiz publication check (00:00 Europe/Paris, DAILY-1 — operator pre-schedules rows in `daily_quiz`; a gap alert fires if tomorrow is empty); weekly-rank snapshot (§11); nightly availability re-check of official/daily quizzes and weekly for user quizzes (§5.3); hourly **ephemeral-quiz sweep** (delete `quiz` rows past `ephemeral_until` — by construction leaf rows, §6); `daily_guest_claim` purge past 48 h (§6).
- **Observability:** pino structured logs → journald/loki-less (just files + logrotate) at v1; `/healthz` endpoint watched by an external uptime monitor (Uptime-Kuma on the same box or healthchecks.io); error tracking via Sentry (free tier) or GlitchTip if self-host preferred.
- **Product metrics (§18 of the functional spec):** a fourth container runs **self-hosted Plausible** on the same VPS — cookieless and personal-data-free, so it needs no consent banner (LEGAL-5) and satisfies MET-3. It covers traffic and page-level funnels only.
  - The funnels that matter (MET-1) are **derived from tables that already exist** — no event pipeline. A nightly job writes aggregate rows to a `metrics_daily` table (`day · metric · value`): daily-quiz start/complete/share counts, challenge open→play→complete, guest→account conversions, D1/D7 return cohorts from `game_session`, streak-length histogram. `/admin` renders them as a small dashboard with the MET-2 target line (D7 ≥ 25 %, median streak ≥ 3) drawn on the chart, so the bar is visible rather than remembered.
  - `metrics_daily` holds counts only, never player identifiers.
- **Operator tooling:** an **`operator` role** on the app-operator account (boolean flag on `user`, granted via a one-off script). The existing quiz builder (CREATE-1) gains, for operators only, a "publish as official" option with localized name/description fields (CREATE-8) — curation reuses the full builder UX (catalog search, clip preview, reordering). A single `/admin` route (operator-gated in `hooks.server.ts`) shows: the daily-quiz calendar with drag-to-schedule and gap warnings (CREATE-9), and sessions flagged by plausibility checks (§7.3). No other admin surface in v1.

---

## 16. Security & GDPR

- All Deezer calls server-side; strict CSP (`default-src 'self'; media-src cdn-preview-*.dzcdn.net; img-src *.dzcdn.net 'self'`). **No third-party scripts at all** — Plausible is self-hosted and same-origin, so the CSP needs no exception for it.
- **No advertising, profiling, or behavioural tracking (LEGAL-2).** This is a standing architectural constraint, not a v1 scope note: the 13+ age threshold (LEGAL-1) and the absence of a consent banner (LEGAL-5) both depend on it. Any future proposal to add ad tech re-opens GDPR Art. 8, cookie consent, and the minimum-age decision together.
- **Age check (LEGAL-1):** `birthYear` collected at signup, 13+ enforced server-side at account creation. Guests are never asked — they supply nothing but a nickname.
- Personal data inventory: email, display name, avatar URL, OAuth subject IDs, gameplay history, friendships, IP in transient logs (14-day rotation), and `daily_guest_claim.ip_hash` — pseudonymous, day-salted (unlinkable across days), purged after 48 h, used solely for FAIR-7 dedupe. All on the EU VPS + EU object storage. Litestream replicas are encrypted at rest (storage-side) — enable client-side encryption in litestream config.
- ACC-6 deletion: single transaction per §6 semantics; email kept only as a salted hash for 30 days to prevent instant re-registration abuse, then purged. Data export (GDPR access, LEGAL-4): JSON dump endpoint under `/api/me/export`, reachable from the profile UI without contacting support.
- Personal data inventory additions from §12: `birthYear` (year only — the check needs no more), `extendedInput` (an accessibility preference, so treated as sensitive: never exposed on any public surface, never in exports of _other_ players' data, and not inferable from a board since the untimed board's membership is the point).
- Secrets: `.env` on the server only, never in the image; OAuth secrets + SMTP creds + Litestream keys.

## 17. Testing & CI

- **Unit (Vitest):** exhaustive coverage of `src/lib/game/` — normalization tables (accents, articles FR/EN, parentheticals, feat., typo distances), curve values at boundary times, plausibility-check edge cases. Property tests via fast-check (§8.2).
- **Integration (Vitest + in-memory SQLite):** session lifecycle incl. finalize re-validation in both plausibility tiers (verified and reconstructed/offline), FAIR-1/2/7 gating, content-edit lock once challenged or scored (CREATE-3) and Duplicate, deletion semantics — a deleted account must leave other players' boards and their `quiz_id` FKs intact — guest→account re-attribution incl. the FAIR-2 collision case, ephemeral-quiz promotion and sweep, board queries + tie-breaks.
- **E2E (Playwright):** the acceptance snapshot verbatim — open challenge link as guest → nickname → play 10 rounds (Deezer stubbed with fixture MP3s) → typo'd guesses score → reveal → board placement; plus FR/EN switch and daily flow.
- **Accessibility (Playwright + `@axe-core/playwright`, A11Y-1):** every route scanned; serious/critical violations fail the build. Beyond the scanner — which catches maybe half of what matters — two scripted checks: a **keyboard-only** run through a full quiz (no pointer events at all), and assertions that the live regions announce countdown, accept/reject, and reveal in order and never during clip playback (A11Y-2/3).
- **CI (GitHub Actions):** lint (eslint + prettier, incl. `eslint-plugin-jsx-a11y`'s Svelte equivalent `svelte-check` a11y warnings as errors) → typecheck → unit/integration → build + size budget → Playwright incl. axe → deploy on `main`.
- Deezer is **always stubbed** in tests; the live probe (§5.5) runs on demand and weekly on a schedule to detect catalog drift.

---

## 18. Implementation order

1. **Phase 0 — go/no-go:** catalog probe (§5.5); ToS ADR; D-1 domain check. _Everything else waits._
2. **Phase 1 — engine core:** shared `game/` lib (normalize/match/scoring) fully tested; DB schema; session lifecycle with hybrid validation; solo play with generated quizzes (guest-only, no accounts yet). **Accessible round flow and the axe gate land here, with the round flow itself** — semantics, live regions, focus, and keyboard operability are cheap now and a rewrite later. _This phase already proves the whole risk surface: audio timing, preloading, validation feel, and whether the game is playable without sight._
3. **Phase 2 — identity:** Better Auth, profiles (incl. age check and the extended-input setting), guest import, manual quiz creation, official catalog + operator role & `/admin` page.
4. **Phase 3 — loops:** daily quiz + streaks + share text; challenges + mini-boards; friends; weekly ladder; stats; `metrics_daily` job and the `/admin` dashboard — the loop ships measured, not measured later.
5. **Phase 4 — polish & launch:** localization pass, unfurl, profanity filter, perf budgets, restore drill, GDPR endpoints, **ToS + privacy policy FR/EN (launch blocker)**, keyboard/screen-reader pass on real assistive tech, E2E green.

## 19. Risks

| Risk                                                                        | Mitigation                                                                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deezer API/ToS change or preview removal                                    | Provider interface (§5.1); iTunes Search API as documented fallback adapter; weekly probe detects drift early                                                                    |
| Preview-URL expiry mid-session                                              | URLs resolved at session start and fully preloaded — a session in progress never re-fetches                                                                                      |
| SQLite single-node ceiling                                                  | Orders of magnitude above V1 needs; Litestream gives painless restore/migration to a bigger box; Postgres migration is the documented escape hatch, not a v1 cost                |
| Client-pack answer extraction                                               | Accepted by design (FAIR-4); boards protected by server re-validation + plausibility checks (§7.3)                                                                               |
| Mid-day takedown on the daily quiz voids every session that hits it (MUS-5) | Nightly availability re-check ahead of publication (§5.3); operator alert + automatic disqualification of the affected quiz from the daily slot before it is served              |
| Content-edit lock (CREATE-3) frustrates creators who share early            | Duplicate is one click (CREATE-10) and the lock is explained at share time; revisit only if creators actually hit it                                                             |
| Guest daily dedupe false-positives behind CGNAT / shared Wi-Fi              | Fails open by design (FAIR-7) — the player plays and is told the run is unscored; monitor the block rate and loosen if it is material                                            |
| Untimed boards stay empty and the accommodation reads as a ghetto           | Untimed board is only shown as a toggle where it has entries; a player using extended input still sees their own row and history normally. Revisit if usage is real but isolated |
| Automated a11y checks create false confidence (axe catches ~half)           | Scanner is the floor, not the ceiling: keyboard-only E2E run + live-region assertions in CI (§17), and a manual pass on real assistive tech before launch (§18 Phase 4)          |
| ToS/privacy drafted in-house drift from the system as built                 | Privacy policy is written from §16's inventory and re-read whenever the inventory changes; professional review before any growth beyond a hobby footprint                        |
| iOS audio quirks (autoplay, decode)                                         | AudioContext unlocked on user gesture; Phase 1 tests on real iPhone before building further                                                                                      |
| Daily-quiz gap (operator forgets)                                           | Pre-scheduled rows + gap alert (§15); fallback auto-generation under operator settings (CREATE-9)                                                                                |
