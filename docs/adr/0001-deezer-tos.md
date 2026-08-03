# ADR-0001: Deezer API Terms of Use — go/no-go for the catalog provider

**Status:** Accepted (conditional — see Decision and Open risks)
**Date:** 2026-08-03
**Owner task:** implementation-plan.md 0.4 / technical-spec.md §5.2 action item
**Related:** GATE 0 requires this ADR to conclude "acceptable" (or "acceptable with conditions") before Phase 1 starts. technical-spec.md §19 documents the iTunes Search API as the fallback provider behind the same `CatalogProvider` interface (§5.1).

---

## Context

The tech spec (§1, §5) commits Devinyl's music catalog to the **Deezer public API**: free 30-second preview MP3s without requiring the end-user to authenticate, and the strongest French-repertoire coverage of the free options (MUS-8). §5.2 explicitly deferred the ToS question: _"Action: re-read the Deezer API ToS at implementation start and record the conclusion as an ADR — same footing as D-1."_ This is that ADR.

The product shape this has to be checked against: a free, ad-free, non-commercial-in-v1 music-guessing game. Guests and registered users search for and play 30-second preview clips resolved live from Deezer at session start (never stored — §5.2), see cached text metadata (title, artists, album, genre, release year, cover **URL**, never the cover binary), and see a "Powered by Deezer" attribution. V1 targets a public daily quiz, shareable challenge links, and public leaderboards — reachable by anyone with the link or the `workers.dev`/custom domain, not a closed, invite-gated group. That distinction matters below.

---

## Sources consulted (fetched 2026-08-03)

- `https://developers.deezer.com/termsofuse` — full text retrieved via `curl` (rendered HTML stripped to text) to get verbatim clauses, since the summarized fetch initially returned paraphrase, not quotes.
- `https://developers.deezer.com/api` — landing page; defers to `/termsofuse` for terms, no independent technical detail.
- `https://developers.deezer.com/guidelines/getting_started` — app-registration flow ("Create an application id for your project…").
- `https://developers.deezer.com/guidelines/logo` — mandatory logo requirement.
- `https://support.deezer.com/hc/en-gb/articles/360011538897-Deezer-FAQs-For-Developers` — developer FAQ (caching, rate limit, commercial-use Q&A).
- Web search for third-party corroboration of the 50 req/5s rate-limit figure (RapidAPI mirror docs, community write-ups) — **no official Deezer page in this pass stated a numeric rate limit**; see Q2 below.
- `docs/technical-spec.md` §1, §5.2, §19 (existing internal assumptions, checked against the above).

I could not reach an "API Terms" page distinct from `/termsofuse`, and did not find a 2024–2026 changelog/deprecation announcement for the public API in this pass — Deezer does not appear to publish one in an easily discoverable place. Treat the absence of a found announcement as "not found," not as "confirmed unchanged."

---

## Findings, question by question

### 1. Does search/track/album/genre access require an API key or app registration today?

Ambiguous, and the two official surfaces disagree in emphasis:

- The Terms of Use (§I–§II) frame all access as **conditional on accepting the Terms and going through the developer flow**: _"Access to the DEEZER API shall be provided to the Developer on the Site following the process indicated at the following URL…"_ and getting_started instructs: _"Create an application id for your project by clicking on 'Create a new application' button."_
- In practice, Deezer's unauthenticated REST endpoints (`api.deezer.com/search`, `/track/{id}`, `/album/{id}`, `/genre`, `/chart/{id}/tracks`) are widely documented and used **without** an API key or OAuth token for public-catalog reads — this matches technical-spec §5.2's assumption ("Public API, no key required for search/track/album/genre reads"). An "application id" appears to matter for OAuth-gated actions (user data, full-track access for Premium+ accounts) rather than for the plain catalog reads this project uses.

**Verdict:** the _technical_ mechanics (no key needed for the endpoints we call) are almost certainly still correct. But **acceptance of the Terms of Use is required regardless of whether a key is issued** ("Access... is strictly subordinate to the acceptance without any reserve... of the present Terms by every developer"), and those Terms are far more restrictive than "just don't need a key" implies — see Q6.

### 2. What are the stated rate limits?

**Not found on an official page in this pass.** The developer FAQ says: _"Is there a limitation on the amount of data returned by the API? No, there is no limitation on data in the API, but there is a query quota."_ — no number given. The commonly cited figure of **50 requests / 5 seconds per IP**, which technical-spec §5.2 and implementation-plan 1.9/1.18 build the request queue and rate-limiter around, comes from third-party/community sources (RapidAPI mirror docs, developer blog posts), **not** a page Deezer itself publishes that I could locate. Treat 50/5s as an unverified-but-plausible working assumption, not a contractual number. **Obligation: build the queue defensively** — respect `Retry-After`/429 responses at runtime regardless of the assumed number, don't hard-code 50/5s as authoritative.

### 3. Is caching metadata permitted, and for how long?

**Text metadata: yes, no duration stated.** FAQ: _"Is it possible to store artist and track names locally without stocking the audio? Yes, it is possible."_
**Images: explicitly no.** FAQ: _"Can I store Deezer images as cache? No, images are not allowed to be stored for legal reasons."_

This is directly relevant: `track_cache` (§6) stores `coverUrl` as a **string pointer to Deezer's CDN**, never the image bytes — that design already matches the rule. **Obligation: never add binary image caching/proxying of Deezer cover art** to `track_cache` or any CDN/KV layer, now or in V2/V3 (e.g. no "cache cover art in R2 for reliability" without re-checking this clause).

### 4. Is linking/hotlinking the 30s preview MP3 permitted? Is storage/proxying prohibited?

**Hotlinking/streaming for playback: yes, by design of the product Deezer built.** FAQ: _"Why am I getting only 30 second previews via the API despite having a Premium account? Because of legal reasons, we can't provide you with the audio file directly from our API"_ — i.e., the 30s preview _is_ the sanctioned form of audio access for non-Premium+ playback.

**Storage/downloading/proxying: explicitly prohibited.** ToS §V (Digital Rights Management): _"The Developer recognizes that the Content are protected by Digital Rights Managements (DRM)... The Developer undertakes not to bypass, by any means, these measures, for the purpose of downloading the Content, or more broadly using the Content in violation of the present Terms."_

This matches technical-spec §5.2's existing posture exactly: _"we never store preview URLs... no audio is stored or proxied."_ **Obligation: keep it that way** — no server-side caching/re-hosting of preview MP3 bytes, no Worker-side proxy that persists audio, ever (this also rules out a Cloudflare Cache API / R2 cache of preview audio as a latency optimization without revisiting this ADR).

### 5. What attribution is required?

**Logo display is mandatory, not optional.** `guidelines/logo`: _"Each application using Deezer API/SDKs must have to include a clearly visible Deezer Logo... The respect of these logo guidelines is mandatory."_ ToS §II confirms the Trademark Guidelines are _"full part of this Terms."_ A separate, **non-mandatory** "Graphical Toolkit" exists at deezerbrand.com for broader visual-identity guidance.

I could not retrieve the exact minimum-size / clear-space / dark-vs-light-logo specifics or a literal "Powered by Deezer" text mandate from the pages reachable in this pass (guidelines/logo defers to deezerbrand.com for the granular spec). **Obligation:** technical-spec §16/§4.6 already plans a "Powered by Deezer" text attribution on reveal cards + footer — **this must be upgraded to include the actual Deezer logo mark** (not text alone), pulled from the current, non-deprecated logo asset at `developers.deezer.com/guidelines/logo` — the old "logo with curve & reflection" version is explicitly banned ("strictly forbidden").

### 6. Is our use case plainly permitted, plainly prohibited, or ambiguous?

**Ambiguous, and this is the important finding of this ADR.** ToS §IV (NON-COMMERCIAL USE), verbatim:

> "The Developer agrees that the use of the Services is strictly limited for a non-commercial purpose and in a non-commercial environment."
> "...the Developer shall not perceive, receive, generate, benefit or create directly or indirectly, any moneys, incomes, revenues, data or any other consideration in connection with the use of neither the Services themselves, nor any and all Content accessed through the Services."
> "Furthermore, it means both the Services and the Content accessed through the Services, shall not be associated, directly or indirectly with any trademark, brand name, or logo."
> "The Developer undertakes to inform by any means any person accessing the Content... that the streaming of the recordings is limited to a strictly private use within a family scope."
> **"The use of the Content is limited to a strictly private use within a family scope."**

The non-commercial clause maps cleanly onto v1's ad-free, non-monetized design — that part is fine. The **"strictly private use within a family scope"** clause does not map cleanly onto the product as planned: a public daily quiz reachable by anyone with the URL, shareable challenge/invite links intended to spread beyond the creator's household, public leaderboards, and (per the implementation plan) a POC field test with friends followed by a public launch on a custom domain. Read literally and narrowly, "family scope" is a materially smaller circle than "the internet, gated only by knowing a link." No amount of "it's free" cures that gap — the clause is about _scope of audience_, not price.

I found no case law, enforcement history, or Deezer statement clarifying how strictly they interpret or enforce this clause against small non-commercial hobby projects, and it was not resolvable from the pages available to me. I am not going to assert a comfort level I don't have evidence for.

### 7. Commercial-use / monetization clauses (flagged for future, out of v1 scope)

Directly relevant if the product is ever monetized: the same §IV text above is an unconditional bar — no ads, no subscriptions, no "any... consideration" tied to use of the Services or Content, and no co-branding/sponsor association. If V1 or later ever explores monetization, this ADR must be revisited _before_ that work starts; the ToS points to a **partnership path** instead (FAQ: _"There is no paid API, but if you'd like to partner with Deezer, you can contact us with this form"_) rather than continued use of the free developer terms.

---

## Decision

**Acceptable with conditions — proceed for the free-tier POC and friends test scoped in implementation-plan.md Phase 0–3, subject to the checklist below, with an explicit re-check gate before any public V1 launch.**

Rationale: the technical assumptions in technical-spec §5.2 (no key for reads, previews streamable not storable, metadata cacheable, images not cacheable) all check out against source text or corroborating official pages. The blocking risk is not technical, it's the "private use within a family scope" clause against a product that is designed to grow past that scope. For **Phase 0–3** (Cloudflare free tier, `workers.dev`, POC shared only with a small, known friends group per 3.15), a defensible reading of "family/private scope" plausibly covers it. That reading gets harder to defend the moment the product moves to a custom domain with an open daily quiz and public leaderboards (Phase 4, GATE 4 = LAUNCH) — at that point this ADR's conclusion no longer covers the deployment and must be revisited, ideally with real legal review rather than another agent's document reading.

This is **not** "acceptable — proceed" without qualification, because I cannot certify the family-scope clause is satisfied at public-launch scale, and I am not the right authority to make that legal call. It is **not** "not acceptable" either, because nothing here plainly bars the free, friends-scoped POC, and switching providers pre-emptively would be premature given how well the iTunes Search API fallback (§19) remains an available, low-cost escape hatch if this conclusion changes.

### Obligations checklist (binding on implementation, not just documentation)

- [ ] **No image caching/proxying.** `track_cache.coverUrl` stays a Deezer CDN URL string; never fetch-and-store cover art bytes (server, KV, R2, or client cache) — confirmed prohibited (Q3).
- [ ] **No audio storage or proxying, ever.** Preview MP3s are fetched client-side (or resolved fresh server-side per §7.1) and never persisted, cached in Cloudflare Cache API, or re-served from our infrastructure — confirmed prohibited (Q4); already technical-spec §5.2 policy, keep it that way through V2/V3.
- [ ] **Rate limiting stays defensive, not hard-coded to an unverified number.** Respect actual 429/`Retry-After` responses from Deezer at runtime; treat "50 req/5s" (1.9, 1.18) as a starting assumption to tune down from, not a contractual ceiling (Q2).
- [ ] **Deezer logo, not text alone, in the attribution.** Upgrade the planned "Powered by Deezer" text (§16, plan 4.6) to include the actual current Deezer logo mark (current version only — the old curved/reflection logo is explicitly banned) on reveal cards + footer (Q5).
- [ ] **No sponsor/brand co-association** on any surface where Deezer content or the Deezer logo appears (ToS §IV) — relevant if the game ever runs any promotional or sponsor placement, even non-monetary.
- [ ] **Keep the POC's actual reach small and known** through Phase 3 (3.15's friends field test) — don't index it for search engines, don't post it to public forums/socials, while this ADR's "family scope" reading is the only cover it has.
- [ ] **Re-open this ADR before Phase 4 (public launch, GATE 4)** — see Revisit trigger below. Do not treat GATE 0's "acceptable" as still valid at launch scale without re-reading it.
- [ ] **If monetization is ever explored**, stop and either pursue Deezer's partnership path or re-provider — the current Terms flatly bar it (Q7).

---

## Consequences

- Phase 0's GATE 0 can proceed treating this ADR as satisfied for the friends-scoped POC — but "satisfied" here means "conditionally, with an explicit re-check obligation," not "solved forever." Whoever runs Phase 4 must not skip re-reading this.
- The `CatalogProvider` abstraction (§5.1) remains load-bearing: if the family-scope reading turns out not to survive public launch, the iTunes Search API fallback (§19) is the documented way out, and this ADR is the trigger document for evaluating it, not a NO-GO signal for launch outright.
- Attribution work (plan 4.6) gains a firm requirement: the actual Deezer logo mark, not text-only "Powered by Deezer." This should be reflected when 4.6 is implemented.
- No change needed to the current no-store posture for audio/images — it was already compliant; this ADR is confirmation, not a new constraint.

---

## Open risks

1. **"Private use within a family scope" vs. a public product is the central unresolved risk.** This ADR cannot certify it away — it can only document it honestly and set a re-check gate. Recommend the human owner get an actual legal read (even a cheap one) before Phase 4, not just another document pass, especially once a custom domain and public leaderboards are live (plan 4.5 already earmarks "professional legal review recommended before growth" for ToS/Privacy Policy — extend that review's scope to include this ADR's question).
2. **The 50 req/5s rate limit is unverified against an official source** in this pass. If Deezer enforces something stricter or looser, the queue design (1.9, 1.18) needs to adapt at runtime via observed 429s rather than assuming the number is contractual.
3. **No confirmed absence of a 2024–2026 deprecation notice** — I did not find one, but I also did not find an official changelog/status page to check against, so "not found" is a gap in my search, not a clean bill of health. Recommend the weekly live-catalog probe (plan S.6, tech-spec §17) double as an early-warning system for silent API changes, which it already does by design.
4. **Exact logo placement/sizing spec not retrieved** (deferred to deezerbrand.com, not fetched in this pass) — whoever implements plan 4.6 should pull the current asset and spec directly from `developers.deezer.com/guidelines/logo` → deezerbrand.com at implementation time, not from this ADR's summary.
5. **This document is not legal advice** and should not be treated as a substitute for the review already planned at plan 4.5.
