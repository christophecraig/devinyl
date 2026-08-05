# Data inventory (LEGAL-4, §16) — plan task 4.4

This is the source of truth task 4.5's ToS/Privacy Policy gets written **from**
— not the other way around. If a fact here and a fact in `technical-spec.md`
§16 disagree, this document wins: it's checked against the actual schema
(`src/lib/server/db/schema.ts`) and the actual retention code
(`src/lib/server/jobs/index.ts`, `delete-account.ts`, `finalize.ts`), not
re-derived from the spec's prose. Where implementation deviated from the
spec's original assumption (most visibly: no VPS, no Litestream, no
self-hosted Plausible — see `docs/adr/0002-cloudflare-hosting.md`), that's
called out per row rather than glossed over, per this repo's own stated
practice (`implementation-plan.md` §G).

Every row below answers four questions: **what** is collected, **why**
(which spec requirement demands it), **how long** it's kept, and **whether**
it's reachable via the two GDPR endpoints this task adds/re-verifies —
`GET /api/me/export` (access, this task) and `DELETE /api/me` (erasure,
ACC-6, task 2.11).

## Legend

- **Export**: does `exportUserData()` (`src/lib/server/me/export.ts`) return this field to the account that owns it?
- **Deletion**: what `deleteAccount()` (`src/lib/server/me/delete-account.ts`) does to it on `DELETE /api/me`.

---

## Account & profile (`user` table)

| Field                                   | Why collected                                                                                                                                                                 | Retention           | Export                                                                                                                                                                       | Deletion                                                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`                                 | ACC-3 sign-in identity; Better Auth requires it                                                                                                                               | Kept until deletion | Yes                                                                                                                                                                          | Replaced with a non-deliverable placeholder; the real value survives 30 days as a keyed HMAC hash (`deletedEmailHash`/`deletedEmailHashExpiresAt`) solely to block instant re-registration abuse, then purged by `purgeDeletedUserTombstones` (task 2.11) |
| `displayName` / `displayNameNormalized` | ACC-5 uniqueness, shown on every board/friends list                                                                                                                           | Kept until deletion | `displayName` only (the normalized form is an internal uniqueness index, not user-facing data)                                                                               | Replaced with "Deleted player"                                                                                                                                                                                                                            |
| `avatarUrl` / `image`                   | Profile display                                                                                                                                                               | Kept until deletion | `avatarUrl` (the `image` column is Better Auth's own field, currently unused by the app beyond auth's own bookkeeping and considered an auth artifact, not app profile data) | Cleared                                                                                                                                                                                                                                                   |
| `locale`                                | LOC-1 preference                                                                                                                                                              | Kept until deletion | Yes                                                                                                                                                                          | Not explicitly cleared (harmless after tombstoning — an anonymized row has no reader)                                                                                                                                                                     |
| `birthYear`                             | **LEGAL-1**: 13+ age gate enforced at signup. Year only — the check needs no more precision                                                                                   | Kept until deletion | Yes                                                                                                                                                                          | Cleared                                                                                                                                                                                                                                                   |
| `extendedInput`                         | A11Y-5 accessibility preference. §16 explicitly flags this as sensitive: never on a public surface, never in _another_ player's export, never inferable from board membership | Kept until deletion | Yes, in the owning user's **own** export only — `exportUserData` never reads another account's row                                                                           | Cleared                                                                                                                                                                                                                                                   |
| `isOperator`                            | §15 operator role, gates `/admin`                                                                                                                                             | Kept until deletion | No (internal authorization flag, not personal data the user needs handed back — and an operator's own awareness of their role isn't something an export serves)              | Cleared                                                                                                                                                                                                                                                   |
| `createdAt` / `updatedAt`               | Bookkeeping                                                                                                                                                                   | Kept until deletion | `createdAt` only                                                                                                                                                             | Left as-is on the tombstone (timestamps aren't identifying)                                                                                                                                                                                               |

## Auth credentials (`account`, `session` — Better Auth-owned tables)

| Field                                                               | Why collected                                     | Retention                                                      | Export                                                                                                                                                                                                                                                                                                                    | Deletion                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `account.password` (hash), `accessToken`, `refreshToken`, `idToken` | ACC-3 email+password and Google OAuth sign-in     | Kept until deletion or token expiry                            | **No.** Handing a user's own live session/OAuth tokens or password hash back inside a downloadable JSON file is a bigger exposure than the export is worth — see `export.ts`'s module doc. Only the **fact** of which providers are linked (`providerId`, e.g. `'credential'`, `'google'`) is exported, never the secrets | Hard-deleted immediately (`db.delete(account)`)                                             |
| `session.token`, `ipAddress`, `userAgent`                           | ACC-3 login sessions, 30-day rolling cookie (§12) | Session lifetime (30 days rolling), or immediately on deletion | No (same reasoning as above — a live session token is a credential, not data to hand back)                                                                                                                                                                                                                                | Hard-deleted immediately (`db.delete(session)`) — the account is unusable from that instant |

## Gameplay history (`game_session`, `round_result`)

| Field                                                                                                 | Why collected                                                                | Retention                                                                       | Export                                                                                                      | Deletion                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nickname`, `totalScore`, `status`, `scored`, `scoredBlockReason`, `effectiveScoringMode`, timestamps | Core gameplay (§6/§7); this is the bulk of "what does Devinyl know about me" | Indefinite — a played session is the permanent record a leaderboard is built on | Yes, every session where `userId` = the requester                                                           | Row is **not** deleted — `userId → NULL`, `nickname → "Deleted player"` (§6 board-integrity: the score stays on the board for the _other_ players who share it; the identity doesn't). After anonymization the row is unreachable from any account's export again |
| `round_result.guessLog` (raw guess text + timestamp per attempt), `titleMs`/`artistMs`, `clipMs`      | §7.3 server-side plausibility re-validation                                  | Indefinite (tied to the parent session)                                         | Yes — this is the most granular personal data the app holds about a player and belongs in an access request | Cascades with its parent `game_session` only on hard delete (never happens here); survives anonymization untouched since it carries no identity of its own (keyed only by `session_id`, no `user_id` column)                                                      |

**Guest play** (`guestId`, no `userId`) is out of scope for both endpoints:
guests have no account, so there is nothing to authenticate an export or
deletion request against. A guest's local device history lives in
`localStorage` only, until/unless `POST /api/me/import-guest` (ACC-4)
attributes it to an account — at which point it becomes exactly the
`game_session` row described above.

## Owned quizzes (`quiz`)

| Field                                       | Why collected               | Retention                                                                                                                                                                           | Export                                                                                                                   | Deletion                                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual/generated quizzes with `ownerId` set | CREATE-1..10 quiz authoring | Indefinite for saved quizzes; **24 h TTL** (`EPHEMERAL_TTL_MS`, `generate.ts`) for a generated-but-never-saved quiz, swept hourly by `sweepEphemeralQuizzes` if unused and past TTL | Yes — both live and soft-deleted (`deletedAt` set) quizzes, so a user who deleted a quiz still has a record they made it | Never hard-deleted while the owner's account exists. On account deletion: `ownerId → NULL`, `deletedAt` set (CREATE-4's dead-link page, not a broken FK for anyone still holding a link/challenge/board built on it) |

Official/daily quizzes (`kind IN ('official','daily')`) have no personal
owner (`ownerId` is `NULL` by construction, §6) — nothing here to export or
delete per-user.

## Social (`friendship`)

| Field                         | Why collected                                         | Retention                                                                | Export                                                                                                                                                                        | Deletion                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted/pending friend pairs | FRIEND-1 friends feature, STAT-3 friends board filter | Kept until either party deletes their account or the request is declined | Yes — reduced to `{friendUserId, friendDisplayName, status, requestedByMe}`, never the raw table's `a_user_id < b_user_id` ordering columns, which mean nothing to the reader | Hard-deleted immediately — pure PII nobody else structurally depends on (unlike a game session, a friendship row has no board-integrity reason to survive) |

## Weekly ladder (`weekly_points`, `weekly_rank_snapshot`)

| Field                                                                  | Why collected             | Retention                               | Export           | Deletion                 |
| ---------------------------------------------------------------------- | ------------------------- | --------------------------------------- | ---------------- | ------------------------ |
| Per-ISO-week point totals; best-rank snapshot taken Monday 00:05 (§11) | STAT-4 weekly leaderboard | Indefinite (historical ladder standing) | Yes, both tables | Hard-deleted immediately |

## Imported local history (`imported_history`)

| Field                                                                  | Why collected                                              | Retention  | Export | Deletion                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | ---------- | ------ | ------------------------ |
| Locally-played, never-server-validated session summaries (ACC-4, §G-3) | Feeds STAT-1 and _best_ streaks only — never a leaderboard | Indefinite | Yes    | Hard-deleted immediately |

## FAIR-7 guest daily dedupe (`daily_guest_claim`)

| Field                                                                                    | Why collected                                                                    | Retention                                                         | Export                                                                                                                | Deletion                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ipHash = HMAC(server_secret ‖ day, ip)` — day-salted, unlinkable across days; `guestId` | Stop one IP claiming the daily as multiple guests (FAIR-7); fails open by design | **48 hours**, purged by `purgeDailyGuestClaims` (`jobs/index.ts`) | No — not keyed by `userId` at all; a registered account's own daily plays are already covered by `game_session` above | N/A — not attributable to an account. Never contains a raw IP, only a keyed, day-salted hash that cannot be reversed or linked across days |

## Rate limiting (`rate_limit`)

| Field                                                                                                     | Why collected                                                                                         | Retention                                                                                                                            | Export                                                                                                                                                                                   | Deletion                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `key` (`<bucket>:<identity>`, identity is `user:<id>` / `guest:<id>` / `ip:<addr>`), fixed-window `count` | §10 abuse protection, plan §G-10 (Workers isolates share no memory, so counters need durable storage) | Swept once a window is more than ~1 hour stale (`purgeRateLimitWindows`, `RATE_LIMIT_WINDOW_MARGIN_MS`) — effectively an hour or two | No — a request-rate counter is not personal data about what a player did in the game, and by the time an export could be requested and read, the window has typically already been swept | N/A — even where a key embeds `user:<id>`, the row is a request count, not content, and ages out on its own within hours regardless of deletion |

## Aggregate metrics (`metrics_daily`, `share_event`)

| Field                                                                                 | Why collected           | Retention                                                                                                                        | Export                                             | Deletion                                                                                                |
| ------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Per-day counters (D1/D7 return cohorts, share/open counts, guest→account conversions) | MET-1/3 product metrics | Indefinite, but **counts only, never player identifiers** (§15, enforced by the table shape itself — no `user_id` column exists) | No — nothing here is attributable to an individual | N/A — deleting an account cannot remove "was among the count" from an aggregate that never recorded who |

## IP addresses in transit / request logs

**Spec vs. implementation note:** §16 says "IP in transient logs (14-day
rotation)" — that line describes the original Hetzner/Caddy/pino target
(§15's deployment note, ADR-0002). V1 actually runs on Cloudflare Workers,
where request-level IP handling is Cloudflare's platform layer (edge
request logs / Workers Logs), not application code this repo controls, and
no 14-day rotation is implemented or configurable from here. `clientIp()`
(`src/lib/server/identity.ts`) reads `cf-connecting-ip` per-request to
derive the FAIR-7 hash and the rate-limit identity above — it is read, used,
and discarded within the same request; the app itself never writes a raw IP
to any table. **This row is an open item, not a resolved one** — the actual
Cloudflare-side retention/config (Workers Logs default retention, whether
Logpush is enabled) is ops/observability territory being addressed
separately under task 4.8, not this task. Flagging it here so 4.5's privacy
policy doesn't silently inherit the spec's Hetzner-era claim as fact.

---

## Summary table (quick reference for 4.5)

| Category          | Table(s)                                | Export                     | Erasable                                         | Retention                                |
| ----------------- | --------------------------------------- | -------------------------- | ------------------------------------------------ | ---------------------------------------- |
| Identity/profile  | `user`                                  | Partial (no `isOperator`)  | Tombstoned, not removed (30-day email-hash tail) | Until deletion + 30 days                 |
| Credentials       | `account`, `session`                    | No (by design)             | Hard-deleted immediately                         | Until deletion                           |
| Play history      | `game_session`, `round_result`          | Yes                        | Anonymized, kept for board integrity             | Indefinite                               |
| Owned quizzes     | `quiz`                                  | Yes (incl. soft-deleted)   | Orphaned, soft-deleted                           | Indefinite                               |
| Friendships       | `friendship`                            | Yes (reduced shape)        | Hard-deleted                                     | Until deletion                           |
| Weekly ladder     | `weekly_points`, `weekly_rank_snapshot` | Yes                        | Hard-deleted                                     | Indefinite                               |
| Imported history  | `imported_history`                      | Yes                        | Hard-deleted                                     | Indefinite                               |
| FAIR-7 dedupe     | `daily_guest_claim`                     | No (not user-keyed)        | N/A                                              | 48 hours                                 |
| Rate limits       | `rate_limit`                            | No                         | N/A                                              | ~1–2 hours                               |
| Aggregate metrics | `metrics_daily`, `share_event`          | No (no identifiers stored) | N/A                                              | Indefinite, non-personal                 |
| Request IPs       | — (in-flight only)                      | No                         | N/A                                              | Open item, owned by 4.8 (see note above) |
