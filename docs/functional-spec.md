# Devinyl — Functional Specification

**Status:** Draft v0.3 — 2026-08-03
**Name:** _Devinyl_ (« devine » + vinyl), pending domain & trademark availability check (see §20, D-1).
**Scope of this document:** functional requirements only. Technical architecture, platform stack, and monorepo decisions are deliberately out of scope and will be addressed in a separate technical design document.

---

## 1. Product overview

Devinyl is a music quiz (blind test) application. Players listen to short music clips and race to identify them. The product supports playing alone, challenging friends asynchronously, and — in later releases — playing live with people in the same room or online.

**Target platforms (context, not spec):** web app first; designed so the product can later ship as native iOS, Android, and desktop apps. All functional requirements in this document are platform-agnostic.

**Guiding principles**

- **Zero friction to play:** a guest can go from landing page to playing in under 30 seconds, without creating an account or connecting any music service.
- **30 seconds is the game:** the entire experience is built around short preview clips. No full-track playback, no streaming-service login.
- **Free in v1:** no monetization in scope for v1.

---

## 2. Glossary

| Term             | Definition                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Clip**         | A short audio excerpt (~30 s) of a commercially released track, served from a music preview catalog.                 |
| **Track**        | A song with metadata: title, artist(s), album, artwork, release year, genre.                                         |
| **Quiz**         | An ordered list of tracks (rounds) plus its settings (round count, guess target, answer mode, scoring mode).         |
| **Round**        | One track being played and guessed within a game session.                                                            |
| **Game session** | One play-through of a quiz by one player (v1) or a group (v2+).                                                      |
| **Challenge**    | A shareable instance of a quiz with its own mini-leaderboard, created by a player daring others to beat their score. |
| **Daily quiz**   | The official quiz of the day, identical for all players, with a global daily leaderboard.                            |
| **Guest**        | A player without an account, identified by a self-chosen nickname on their device.                                   |

---

## 3. Roles

| Role                   | Description                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| **Guest**              | Plays without an account. Has a nickname. Limited persistence (see §12).               |
| **Registered player**  | Has an account. Gets saved quizzes, history, stats, friends, and leaderboard presence. |
| **Quiz creator**       | Any registered player, when building or generating a quiz.                             |
| **App operator** (you) | Publishes official curated quizzes and the daily quiz.                                 |
| **Host** (v2)          | The player running a live party or online room.                                        |

---

## 4. Release scope

| Release                        | Contents                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1**                         | Solo play · Daily quiz · Challenge links · Quiz creation (manual, auto-generated, official curated) · Optional accounts · Friends · Stats & leaderboards · FR/EN localization |
| **V2**                         | Local party mode (host screen + phone controllers)                                                                                                                            |
| **V3**                         | Online multiplayer rooms                                                                                                                                                      |
| **Not planned / future ideas** | Teams, hints, user-uploaded audio, public quiz gallery, monetization, custom per-round question text, difficulty via clip-segment selection                                   |

Requirements below are tagged **[V1]**, **[V2]**, **[V3]** accordingly.

---

## 5. Music catalog & playback

- **MUS-1 [V1]** — The app provides access to a large commercial music catalog through **~30-second preview clips**. Players and creators never need a streaming-service subscription or login.
- **MUS-2 [V1]** — Each track exposes at minimum: title, artist(s), album name, album artwork, release year, and genre. Decade is derived from release year.
- **MUS-3 [V1]** — The catalog is searchable by track title and by artist (used in quiz creation, §10).
- **MUS-4 [V1]** — During a round, playback is **audio only**: no title, artist, artwork, or any metadata that could reveal the answer is visible until the reveal.
- **MUS-5 [V1]** — Track availability is validated when a quiz is assembled and re-checked on a schedule; a quiz never ships with a known-dead clip. If a clip nonetheless fails at play time, the round is skipped without penalty and the quiz continues to the end — a quiz must never dead-end on a broken clip. A session containing a skipped round completes and shows its score, but does **not** post to any leaderboard (see FAIR-6): its rounds are not comparable to other players' (SCORE-5).
- **MUS-6 [V1]** — User-uploaded audio is **out of scope**. The preview catalog is the only music source.
- **MUS-7 [V1]** — **Pre-loading:** all clips of a session buffer during a loading screen before round 1. No mid-round stalls (speed scoring stays fair), and a connection drop mid-quiz does not kill the session in progress. For quizzes above **20 rounds**, the app first shows the estimated download size and load time and requires an explicit confirmation before starting; the choice is remembered per device.
- **MUS-8 [V1]** — **French repertoire coverage is a go/no-go criterion** for the catalog provider. The technical phase must start by validating real searches across French chanson, pop, and rap (e.g. Goldman, Stromae, Orelsan) before committing to a provider.

---

## 6. Quiz model & settings

A quiz is created once and playable many times (solo, as a challenge, or later in live modes).

- **QUIZ-1 [V1]** — A quiz has: a name, an ordered list of tracks, and settings (below). It belongs to its creator (or to the app, for official quizzes).
- **QUIZ-2 [V1]** — **Number of rounds:** 5 to 50 tracks; default **10**. This is the only content-volume setting the creator controls.
- **QUIZ-3 [V1]** — **Guess target**, configurable per quiz:
  - _Title + artist_ (default): each is validated and scored independently — a player can get one, the other, or both.
  - _Title only._
  - _Artist only._
- **QUIZ-4 [V1]** — **Answer mode**, configurable per quiz:
  - _Free text_ (default): players type their answer(s); validated per §8.
  - _Multiple choice:_ players pick from 4 options per guess target; generated per §8.
- **QUIZ-5 [V1]** — **Scoring mode**, configurable per quiz: _speed-based_ (default) or _fixed_ (see §9).
- **QUIZ-6 [V1]** — Round order is fixed at creation. Every player of a given quiz/challenge gets the same tracks in the same order (required for fair leaderboards).
- **QUIZ-7 [V1]** — **Multiple-choice retry policy**, configurable per quiz, only meaningful when answer mode (QUIZ-4) is _multiple choice_: _one-shot_ (default, see ANS-7) or _penalty retry_ (see ANS-8), with a **penalty duration** of 0–10 seconds (default 3s), used only in penalty-retry mode. Set alongside the other settings before the game starts; frozen with the rest of the quiz's content once played (CREATE-3).

---

## 7. Round flow

The round flow is identical across all game modes.

1. **ROUND-1 [V1]** — A short pre-round countdown (e.g. 3-2-1) precedes the clip.
2. **ROUND-2 [V1]** — The clip plays **once**, from its start, for its full duration (~30 s). Players may submit answers **at any moment** during playback. No pause, no replay, no scrubbing.
3. **ROUND-3 [V1]** — The round ends when the clip ends, or earlier if the player has submitted final answers for every guess target (in group modes: when all players have).
4. **ROUND-4 [V1]** — **Reveal:** after each round, a reveal card shows the track title, artist, album artwork, and the player's result for the round (what they got right, points earned). In group modes (V2/V3) it also shows who found what.
5. **ROUND-5 [V1]** — **Scoreboard:** after the reveal, standings are shown. Solo: running score and round-by-round recap. Group modes (V2/V3): live standings with position changes highlighted.
6. **ROUND-6 [V1]** — In solo/async play the player advances to the next round themselves. **[V2/V3]** In live modes the host can skip ahead at any time instead of waiting for the inter-round delay.
7. **ROUND-7 [V1]** — At the end of the final round, an **end-of-game summary** shows total score, per-round breakdown, and relevant leaderboard placement (see §13), plus share actions (challenge link, daily-result share).
8. **ROUND-8 [V1]** — Abandoning a session mid-quiz discards it: an incomplete session never posts a score to any leaderboard.

---

## 8. Answering & validation

### Free text

- **ANS-1 [V1]** — When the guess target is _title + artist_, the player has two distinct inputs (title, artist) and may submit them independently, in any order, at any time during the clip. Each locks in when submitted.
- **ANS-2 [V1]** — Validation is **forgiving**. An answer is accepted despite: case differences, missing/extra accents and punctuation, leading articles ("The", "Le/La/Les"…), minor typos (small edit-distance tolerance scaled to answer length), and parenthetical suffixes in official titles ("(Remastered 2011)", "(feat. X)" — the core title is enough).
- **ANS-3 [V1]** — For multi-artist tracks, naming the **primary artist** is sufficient. Featured artists are accepted but not required.
- **ANS-4 [V1]** — An incorrect submission is rejected with immediate feedback, and the player may retry as long as the clip is still playing. Wrong attempts cost no points by themselves (the cost is time, under speed scoring).
- **ANS-5 [V1]** — The app never leaks answer information on a wrong attempt (no "close!" hints, no letter counts).

### Multiple choice

- **ANS-6 [V1]** — Each guess target shows **4 options**: the correct answer and 3 plausible distractors drawn from similar tracks (same genre and/or era). Distractors never duplicate one another or the correct answer.
- **ANS-7 [V1]** — **One-shot** retry policy (default, QUIZ-7): one pick per guess target is final — selecting locks that target immediately, right or wrong. Scoring is unaffected either way (§9); this mode exists so a wrong pick doesn't leave the player stuck rereading a locked screen until the clip ends — it ends that target's involvement immediately and lets the round move on (ROUND-3: the round is ready to reveal as soon as every required target is answered, right or wrong).
- **ANS-8 [V1]** — **Penalty retry** policy (QUIZ-7): a correct pick is still immediately final. A wrong pick disables the whole guess target for the quiz's configured **penalty duration** (0–10 s) — no further pick is accepted during that window — after which it reopens for another attempt, for as long as the clip plays. This rewards a confident first try without punishing a miss beyond the wait: retries stay time-based under speed scoring (a delayed correct answer scores lower, same curve as usual, §9) rather than costing points directly, and the delay stops a player from machine-gunning all 4 options.

---

## 9. Scoring

- **SCORE-1 [V1]** — Each guess target (title, artist) is scored independently. A round's score is the sum of its targets.
- **SCORE-2 [V1]** — **Speed-based mode (default):** a correct answer earns a maximum value (e.g. 1 000 points per target) that decreases with elapsed clip time, down to a floor (e.g. 100). Answering in the first seconds earns close to the maximum.
- **SCORE-3 [V1]** — **Fixed mode:** a correct answer earns a constant value per target, regardless of speed.
- **SCORE-4 [V1]** — Unanswered or never-corrected targets earn 0. There are no negative points.
- **SCORE-5 [V1]** — Quiz total = sum of round scores. Same quiz + same settings ⇒ comparable scores (leaderboard requirement).
- **SCORE-6 [V1]** — The exact point curve is an implementation constant, but must be identical for every player of the same quiz and stable over the quiz's lifetime so leaderboards remain fair.

---

## 10. Quiz creation

Three ways quizzes come into existence:

### Manual creation

- **CREATE-1 [V1]** — A **registered** player can create a quiz: name it, search the catalog (by title or artist), add tracks one by one, reorder or remove them, and set the quiz settings (§6). Creating requires an account; playing does not.
- **CREATE-2 [V1]** — The creator can preview each clip while building (creator has heard the answers by definition; see FAIR-1 for leaderboard implications).
- **CREATE-3 [V1]** — A quiz is freely editable by its creator (tracks, order, settings) **until it has been challenged or has recorded a scored run** by anyone. From that point its content is frozen; the creator can still rename it and edit its description. To change a frozen quiz, the creator uses **Duplicate** (CREATE-10). This guarantees CHAL-1's promise that everyone playing a given link gets the same tracks in the same order, forever.
- **CREATE-4 [V1]** — Creators can delete their quizzes. Existing challenge links to a deleted quiz become gracefully inactive ("this quiz is no longer available").
- **CREATE-10 [V1]** — **Duplicate** copies a quiz's tracks and settings into a new quiz owned by the copier, with an empty leaderboard and no inherited links. Available on any quiz the player can access.

### Auto-generated quizzes

- **CREATE-5 [V1]** — Any player (guest included) can generate a quiz by combining filters: **decade/era**, **genre**, and/or **artist or theme** (free-text seed, e.g. "Daft Punk" or "movie soundtracks"). The app assembles a quiz of the requested length from catalog tracks matching the filters.
- **CREATE-6 [V1]** — Generated quizzes use default settings unless changed, and can be played immediately. A registered player can **save** a generated quiz (it becomes theirs, shareable like a manual quiz); guests can only play it in the moment.
- **CREATE-7 [V1]** — Regenerating with the same filters produces a _different_ selection (variety), but a _saved_ generated quiz is frozen — its track list never changes.

### Official quizzes

- **CREATE-8 [V1]** — The app operator publishes **official curated quizzes** (themed playlists: decades, genres, national repertoires, soundtracks…). They appear in a browsable official catalog inside the app and behave like any quiz (playable solo, challengeable).
- **CREATE-9 [V1]** — The app operator designates the **daily quiz** (see §11). Daily quizzes can be hand-curated or auto-generated under operator control.

---

## 11. Game modes

### Solo play [V1]

- **SOLO-1** — A player (guest or registered) picks any quiz — official, own, generated, or reached via link — and plays it alone, following the round flow (§7).
- **SOLO-2** — At the end, the score is recorded (registered players: history + leaderboards; guests: local device history only) and the player is offered: replay, challenge a friend (§11 Challenges), or pick another quiz.
- **SOLO-3** — Replays are allowed, but only a player's **first completed run** of a given quiz counts for its leaderboard (see FAIR-2). Replays are labeled "practice".

### Daily quiz [V1]

- **DAILY-1** — Each calendar day (operator-defined timezone), one official daily quiz is available, identical for every player worldwide. It has **5 rounds** (shorter than a default quiz: ~3 minutes a day to maximize the daily habit).
- **DAILY-2** — Each player can post **one scored attempt** per day. The attempt feeds a **global daily leaderboard** and a friends view of the same board.
- **DAILY-3** — After playing, the player gets a **spoiler-free shareable result** (score + day number, never track names) to post anywhere — the Wordle-style loop.
- **DAILY-4** — Daily participation feeds streak tracking (consecutive days played) in personal stats.
- **DAILY-5** — Past daily quizzes remain playable as practice but no longer accept leaderboard scores.

### Challenges [V1]

- **CHAL-1** — After completing any quiz, a player can create a **challenge link**. Anyone opening the link (guest or registered) lands directly in that quiz's lobby, sees who challenged them and the score to beat, and plays the exact same quiz (same tracks, order, settings).
- **CHAL-2** — Every challenge has its own **mini-leaderboard** of everyone who played through that link, visible to all its participants. Guests appear under their nickname.
- **CHAL-3** — A challenge link requires no account and no install — on the web it must be playable straight from the browser.
- **CHAL-4** — FAIR-2 applies: one scored attempt per player per challenge; replays are practice.

### Local party mode [V2] — summary requirements

- **PARTY-1** — Kahoot-style topology: a **host screen** (TV/laptop) plays the audio and displays round state, reveals, and the scoreboard; each player's phone is a silent **controller** used only to submit answers.
- **PARTY-2** — Players join via **room code, QR code, or invite link** displayed on the host screen. Joining requires no account.
- **PARTY-3** — Rooms support up to **~10 players**.
- **PARTY-4** — The host picks the quiz, starts each round, and can **skip** ahead at any time. Reveal cards additionally show **who found what, and how fast**.
- **PARTY-5** — A player who disconnects can rejoin the room and resume with their score intact; the game does not block on absent players.

### Online multiplayer [V3] — summary requirements

- **ONLINE-1** — Same structure as party mode, but every participant is remote: each player's own device plays the audio and shows their private game view.
- **ONLINE-2** — Join via room code or invite link; hosts can invite **friends** directly in-app. No public game browser.
- **ONLINE-3** — Rooms support up to ~10 players. Clip playback is synchronized closely enough that speed scoring stays fair across participants.

---

## 12. Accounts, guests & friends

- **ACC-1 [V1]** — **Accounts are optional.** Guests play with a self-chosen nickname; no email, no signup, instant play.
- **ACC-2 [V1]** — An account unlocks: quiz creation & saving, cross-device history, personal stats, friends, and presence on persistent leaderboards. Guest scores appear on challenge mini-leaderboards and the daily board for the day, under the guest nickname, but build no persistent profile.
- **ACC-3 [V1]** — Sign-up/sign-in via email and mainstream third-party identity (e.g. Google, Apple). Exact providers are a technical decision.
- **ACC-4 [V1]** — When a guest creates an account, their play history is carried over. Scores recorded on the server under their guest identity — daily and challenge results — are **re-attributed to the new account**, keeping their existing leaderboard positions and crediting the weekly ladder. Purely local history (played quizzes, scores, daily streak) is imported as personal statistics only and never enters leaderboards.
- **ACC-5 [V1]** — Profiles: display name, optional avatar. Display names are unique enough to be findable (exact mechanism TBD technically).
- **FRIEND-1 [V1]** — Registered players can add friends via username search or an invite link. Friendship is mutual (request + accept).
- **FRIEND-2 [V1]** — Friends unlock: friends leaderboards (§13), direct challenge sending, and — in V2/V3 — direct room invitations.
- **ACC-6 [V1]** — Account deletion removes the profile, personal data, and created quizzes (with the CREATE-4 behavior for their links), in line with GDPR expectations.

---

## 13. Stats & leaderboards

- **STAT-1 [V1]** — **Personal stats** (registered players): games played, average score, best scores, daily-quiz streaks (current & best), breakdown by mode, and most-played genres/decades.
- **STAT-2 [V1]** — **Per-quiz leaderboards:** every quiz has an all-time top-scores board (first completed runs only, per FAIR-2). Visible to anyone who can access the quiz.
- **STAT-3 [V1]** — **Friends leaderboards:** every board (per-quiz, daily, global) has a "friends only" filter.
- **STAT-4 [V1]** — **Global ranking = weekly ladder.** Points from scored play (daily quizzes and official quizzes at minimum) accumulate Monday–Sunday; the board resets every week. Newcomers get a fresh shot weekly. Past weekly results are kept in personal stats (best weekly rank).
- **FAIR-1 [V1]** — A quiz's **creator** is excluded from its leaderboard (they know the answers).
- **FAIR-2 [V1]** — Only a player's **first completed run** of a given quiz/challenge/daily posts a score. All subsequent runs are labeled practice and never affect boards.
- **FAIR-3 [V1]** — Leaderboards show display name/nickname, score, and date. Ties break by earlier completion.
- **FAIR-4 [V1]** — **Lookup tools (Shazam etc.) are accepted in v1.** Async leaderboards are honor-based; the speed-scoring curve already penalizes the seconds a lookup takes. Revisit (e.g. flagging statistically perfect runs) only if boards visibly degrade.
- **FAIR-5 [V1]** — Guests appear on the global daily leaderboard under their nickname. All nicknames and display names pass a profanity filter (French + English) before appearing on any public board.
- **FAIR-6 [V1]** — A completed run whose timing could not be verified, or that contained a skipped round (MUS-5), is shown to the player with its score and a plain explanation that it was not posted to the leaderboard. Verification failures caused by connectivity or a broken clip are stated as such; suspected manipulation is never accused, only silently unscored (FAIR-4 posture).
- **FAIR-7 [V1]** — Each player may post one scored attempt at the daily quiz per day (DAILY-2). For guests this is enforced on a best-effort basis; the check may occasionally treat two people on the same network as one, and in that case it fails open — they play, unscored, with an explanation.

---

## 14. Sharing & discovery

- **SHARE-1 [V1]** — User-created quizzes are **private by default** and shareable **by link only**. There is no public gallery, browse, or search of user content in v1 (no moderation surface).
- **SHARE-2 [V1]** — Anyone with a quiz link can play it and see its leaderboard; the link does not allow editing.
- **SHARE-3 [V1]** — Official quizzes are the only publicly browsable content (in-app official catalog).
- **SHARE-4 [V1]** — Shareable objects: quiz links, challenge links, daily spoiler-free results, friend invite links. All unfurl in messaging apps with a **branded preview that never shows track artwork, titles, or artists** — a link preview must not spoil the quiz it points to. Challenge previews may show the challenger's nickname and the score to beat.

---

## 15. Localization

- **LOC-1 [V1]** — Full UI localization in **French and English** at launch; language auto-detected from the device/browser and switchable in settings.
- **LOC-2 [V1]** — Track metadata (titles, artist names) is displayed as-is from the catalog — never translated.
- **LOC-3 [V1]** — Official quiz names/descriptions are localized. Dates, numbers, and rank formats follow the active locale.

---

## 16. Accessibility

A blind test is an audio game with a running clock — two properties that make accessibility a design constraint rather than a polish item. These requirements apply from the first line of UI code; they are not a Phase 4 pass.

- **A11Y-1 [V1]** — The product targets **WCAG 2.2 level AA**. Automated checks run in CI on every build and a failure blocks the build. Retrofitting AA after the fact costs far more than building to it, and the European Accessibility Act applies to consumer services in the EU.
- **A11Y-2 [V1]** — **The round flow is fully operable without sight.** The pre-round countdown, clip start and end, accept/reject feedback, reveal card, and scoreboard are all announced to assistive technology; no state is conveyed by colour, position, or animation alone. Every interaction is keyboard-operable with a visible focus indicator.
- **A11Y-3 [V1]** — **The audio channel belongs to the clip.** No UI sound effects, no voice, and nothing else plays during a clip — a screen-reader user is listening to the same channel the game is testing them on. Non-essential announcements are deferred to the gaps between clip playback.
- **A11Y-4 [V1]** — **Fixed scoring (QUIZ-5) is the accessible mode.** It is presented as such in quiz creation, and any quiz can be replayed solo in fixed mode.
- **A11Y-5 [V1]** — **Extended input** is a profile setting for players who cannot answer under time pressure. It forces fixed scoring for that player's runs regardless of the quiz's setting. Because such runs are not comparable to timed ones, every speed-scored quiz carries **two boards — timed and untimed** — and the player is told plainly which one they are on. Segregating the board is the price of not excluding the player from it.
- **A11Y-6 [V1]** — Motion respects `prefers-reduced-motion`; text meets AA contrast in both themes; text resizes to 200 % without loss of function; form inputs are labelled and error messages are programmatically associated.
- **A11Y-7 [V1]** — Accessibility strings are localized alongside the rest of the UI (LOC-1) — an announcement in the wrong language is an announcement that failed.

---

## 17. Legal, privacy & minors

- **LEGAL-1 [V1]** — Accounts require a self-declared **13+** date of birth at signup. Guest play collects no personal data beyond a chosen nickname and is not age-gated.
- **LEGAL-2 [V1]** — **No advertising, no profiling, no third-party trackers, no behavioural data sale — ever, not just in v1.** This is what keeps the product age-neutral and consent-light; the 13+ threshold in LEGAL-1 rests on it. Reversing it re-opens GDPR Art. 8 parental-consent obligations and the whole consent-banner surface.
- **LEGAL-3 [V1]** — **Terms of Service** and a **Privacy Policy** exist in French and English before launch, linked from the footer and from the signup form. The privacy policy states what is collected, why, how long it is kept, that music is served by a third-party catalog provider, and how to exercise access and deletion rights. Both documents must match the system as built, not a template.
- **LEGAL-4 [V1]** — Players can **export** their data and **delete** their account (ACC-6) from within the app, without contacting support.
- **LEGAL-5 [V1]** — Only strictly-necessary cookies are used (the session cookie). No consent banner is required, and none is shown.

---

## 18. Success metrics

The daily loop is the product's central retention bet (DAILY-3, DAILY-4). It ships measured.

- **MET-1 [V1]** — Instrumented funnels: challenge link **opened → played → completed**; **guest → account** conversion; daily quiz **started → completed → shared**; **D1 and D7 return**; streak length distribution.
- **MET-2 [V1]** — **v1 success bar:** ≥ **25 % D7 return** among players who complete at least one daily quiz, and a **median streak ≥ 3** among returning players. Missing the bar is a signal to revisit the loop, not the catalog.
- **MET-3 [V1]** — Measurement is **aggregate and personal-data-free**, self-hosted, and consistent with LEGAL-2. No analytics vendor receives player data.

---

## 19. Out of scope for v1 (explicit)

- Local party mode (V2) and online multiplayer (V3) — specced above at summary level only; each gets a detailed spec before its release.
- Teams, in any mode.
- Hints of any kind during a round.
- User-uploaded audio files.
- Public gallery / community discovery of user quizzes.
- Monetization (ads, premium) — product is entirely free in v1.
- Custom per-round question text ("name the movie…") and creator-chosen clip segments/lengths.
- Moderation tooling (only needed once public user content exists).

---

## 20. Decision log

All open questions from draft v0.1 were resolved on 2026-08-03:

| #    | Question                    | Decision                                                                                                                                                          |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Product name                | **Devinyl** (« devine » + vinyl). ⚠️ Remaining action **D-1**: verify domain & trademark availability before public use; fall back to another candidate if taken. |
| OQ-2 | Daily quiz length           | **5 rounds** (DAILY-1).                                                                                                                                           |
| OQ-3 | Shazam/lookup in async play | **Accepted in v1**, honor-based boards (FAIR-4).                                                                                                                  |
| OQ-4 | Global ranking shape        | **Weekly ladder**, Monday–Sunday, weekly reset (STAT-4).                                                                                                          |
| OQ-5 | Guests on the daily board   | **Yes**, under profanity-filtered nicknames (FAIR-5).                                                                                                             |
| OQ-6 | French catalog coverage     | **Go/no-go criterion**, validated first in the technical phase (MUS-8).                                                                                           |
| OQ-7 | Connectivity during a quiz  | **Pre-load all clips at session start** (MUS-7).                                                                                                                  |

Resolved on 2026-08-03 during technical-spec reconciliation (draft v0.3):

| #     | Question                                          | Decision                                                                                                                                                                             |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-8  | Skipped round (dead clip) on leaderboards         | **Validate availability at assembly**; a session with a skip completes but never scores (MUS-5, FAIR-6). Comparability of boards wins over saving the odd run.                       |
| OQ-9  | Full pre-load vs. the 50-round ceiling            | **Keep full pre-load at every length**; warn + confirm above 20 rounds (MUS-7).                                                                                                      |
| OQ-10 | Editing a quiz that already has challenge links   | **Content edits locked** once challenged or scored; Duplicate instead (CREATE-3, CREATE-10). Replaces the earlier "editing resets the leaderboard" rule.                             |
| OQ-11 | Guests clearing local storage to replay the daily | **Soft, fail-open network-level dedupe** (FAIR-7).                                                                                                                                   |
| OQ-12 | Guest scores when the guest signs up              | **Re-attributed to the account**, boards and weekly ladder included (ACC-4).                                                                                                         |
| OQ-13 | Track artwork in link previews                    | **Never** — branded preview only; a spoiler in an unfurl defeats the quiz (SHARE-4).                                                                                                 |
| OQ-14 | Accessibility commitment                          | **WCAG 2.2 AA, enforced in CI** from Phase 1 (A11Y-1).                                                                                                                               |
| OQ-15 | Players who can't play under time pressure        | **Fixed mode is the accessible mode** (A11Y-4) plus an **extended-input** profile setting that forces it; speed-scored quizzes therefore carry a **second, untimed board** (A11Y-5). |
| OQ-16 | Minimum age & consent basis                       | **13+ self-declared**, resting on a permanent no-ad-tech / no-profiling commitment (LEGAL-1/2).                                                                                      |
| OQ-17 | ToS & privacy policy                              | **Required before launch**, FR+EN, written against the real data inventory (LEGAL-3).                                                                                                |
| OQ-18 | Analytics                                         | **Self-hosted, cookieless, aggregate only** + server-side funnel counters (MET-3).                                                                                                   |
| OQ-19 | v1 success bar                                    | **Retention-first:** D7 ≥ 25 %, median streak ≥ 3 (MET-2).                                                                                                                           |

---

## 21. Acceptance snapshot (v1 definition of done)

A stranger receiving a challenge link on their phone can: open it in a browser, enter a nickname, hear 10 clips, type guesses with typos and still score, see the reveal after each round, land on the challenge leaderboard next to their friend's score — in French or English — without ever creating an account, installing anything, or logging into a music service.
