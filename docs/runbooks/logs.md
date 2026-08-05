# Runbook: reading production logs

Plan task 4.8. Two layers exist today: `wrangler tail` (always available, real-time,
nothing to configure) and Sentry (optional, activates once `SENTRY_DSN` is set — see
"What Sentry adds" below). Use `wrangler tail` first; it's free and needs no account
beyond the one you already deploy with.

## Streaming live logs

The Worker is named `devinyl` (`wrangler.jsonc`'s `name` field). From the repo root:

```sh
npx wrangler tail devinyl
```

(or `pnpm exec wrangler tail devinyl` — either resolves the same local `wrangler`
pinned in `package.json`). This opens a live stream of every request and
`scheduled` (cron) invocation hitting the deployed Worker — `console.log`/
`console.error` calls, response status, and (unless filtered out, see below)
the request itself.

Leave it running in a terminal while reproducing an issue, or while a Cron
Trigger is due (`*/15 * * * *`, `0 * * * *`, `5 0 * * *` UTC — see
`wrangler.jsonc`'s `triggers.crons`).

### Filtering

`wrangler tail` supports narrowing the stream so a busy Worker doesn't drown
out what you're looking for:

```sh
# Only failed requests
npx wrangler tail devinyl --status error

# Only one HTTP method
npx wrangler tail devinyl --method POST

# Only requests to a specific path (substring match)
npx wrangler tail devinyl --search "/api/sessions"

# Pretty-print instead of the default single-line-per-event format
npx wrangler tail devinyl --format pretty
```

Combine flags freely (`--status error --method POST`). Run `npx wrangler tail
--help` for the full flag list — it changes between wrangler versions faster
than this doc would stay accurate.

### Cron batches specifically

Each `scheduled` invocation logs one line per job in the batch (see
`src/lib/server/jobs/index.ts`'s `report()`):

```
[jobs:every-15-min] sweep-abandoned-sessions: 3 row(s)
[jobs:every-15-min] purge-daily-guest-claims: 0 row(s)
[jobs:hourly] sweep-ephemeral-quizzes failed: D1_ERROR: ...
```

A job that throws logs `<name> failed: <message>` but does **not** stop the
rest of the batch (`runOne` in `jobs/index.ts` isolates each job). A whole
**batch** failing (something outside an individual job's try/catch — e.g.
`getDb` itself throwing) logs `Job batch "<kind>" failed: ...` from
`worker/entry.ts` and is what a `HEALTHCHECKS_URL` ping (below) would have
gone quiet for.

## What's in the logs today (no Sentry needed)

Every `console.error` call already in the codebase shows up in `wrangler
tail` with no setup — this is the whole observability story until `SENTRY_DSN`
is set. Grep `console.error` under `src/` to see the full current list; the
ones most worth knowing by name:

- `[hooks] session resolution failed` — `src/hooks.server.ts`, a misconfigured
  Better Auth (e.g. missing `BETTER_AUTH_SECRET`) degrading to "no session"
  instead of a 500.
- `[healthz] D1 ping failed` — `src/routes/api/healthz/+server.ts`, the
  uptime-monitor target reporting a database problem.
- `[jobs:<kind>] <name> failed: ...` — one cron job in a batch throwing (see
  above).
- `Job batch "<kind>" failed: ...` — the whole cron batch throwing.
- `[observability:<source>]` — every error routed through `captureError()`
  (`src/lib/server/observability.ts`) logs here regardless of whether Sentry
  is configured; see below.

## What Sentry adds once `SENTRY_DSN` is set

`src/lib/server/observability.ts`'s `captureError()` is the single choke
point: every uncaught server error (via SvelteKit's `handleError` hook in
`src/hooks.server.ts`) and every cron-batch failure (`worker/entry.ts`) is
already routed through it today, but with `SENTRY_DSN` unset it only
`console.error`s — nothing changes in `wrangler tail` until the secret exists.

Once `wrangler secret put SENTRY_DSN` is run, the exact same call sites also
POST the error to Sentry's ingestion API, and it starts showing up in the
Sentry project's Issues view — aggregated across occurrences, with alerting
rules you configure there, which is the thing `wrangler tail` fundamentally
can't do (you have to be watching it live; Sentry watches when you aren't).
`wrangler tail` stays the tool for "what is happening right now," Sentry
becomes the tool for "what broke while nobody was looking."

**Manual verification once `SENTRY_DSN` is set:** trigger any uncaught 500
(or `curl` a route that throws) and confirm the same event appears both in
`wrangler tail` (`[observability:hooks.handleError] ...`) and in the Sentry
project's Issues view within a few seconds.

## healthchecks.io: a different signal

`HEALTHCHECKS_URL` (also `[USER]`, also optional) is not a log at all — it's a
liveness ping fired from `worker/entry.ts` after a cron batch completes
successfully. It answers a question `wrangler tail` and Sentry both miss: "did
the Cron Trigger fire at all today?" A Cron Trigger silently failing to
register (misconfigured `wrangler.jsonc`, a Cloudflare-side issue) produces
_no_ log line anywhere — the healthchecks.io check simply stops receiving
pings, and the service alerts on the gap. See
docs/implementation-plan.md §L for the [USER] setup step.
