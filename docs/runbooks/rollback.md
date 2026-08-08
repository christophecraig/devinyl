# Runbook: rolling back a bad deploy

Plan task S.6. Two paths, in order of preference: `wrangler rollback` (seconds, code
only, no build) and a re-deploy of a known-good commit through the Actions `deploy`
job (minutes, but it moves `master` back too). Reach for the first one during an
incident and the second one afterwards.

Read the D1 section before either. **Rollback moves code, never schema.**

## Fast path: `wrangler rollback`

```sh
# What's deployed, newest first — note the ID you want to go back to
npx wrangler deployments list

# Roll back to the immediately preceding deployment (prompts for confirmation)
npx wrangler rollback

# Or to a specific one
npx wrangler rollback <VERSION_ID>

# Confirm what's live now
npx wrangler deployments status
```

This repoints the `devinyl` Worker at a version that already exists on Cloudflare's
side. There is no build, no upload, and no CI run — it takes effect globally in
seconds. Wrangler asks for a rollback message; write the incident in one line, it
shows up in `deployments list` later.

Rollback is **not** a commit. The repo still has the bad code on `master`, and the
next push to `master` will deploy it again. Fix forward or revert the commit
afterwards — see the next section.

The preview Worker rolls back the same way, with the environment flag:

```sh
npx wrangler rollback --env preview
```

## Slow path: re-deploy a known-good commit

Use this when the bad code needs to leave `master` too (which is almost always, once
the incident is over).

```sh
git revert <bad-sha>          # or: git revert <merge-sha> -m 1
git push origin master
```

That push runs the normal CI pipeline (`.github/workflows/ci.yml`): `build-and-test`
must pass, then the gated `deploy` job applies pending D1 migrations remotely and
`wrangler deploy`s. Expect minutes, not seconds — the full test suite, Playwright,
and Lighthouse all run first, and that gate is not worth bypassing outside a live
outage where `wrangler rollback` was already used to stop the bleeding.

To deploy an older commit **without** touching `master` (e.g. verifying which commit
broke things), do it by hand from a checkout of that commit:

```sh
git checkout <good-sha>
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars     # `wrangler types` needs values; not secrets
pnpm run build
npx wrangler deploy
```

Note what this skips: no migrations are applied (deliberate — see below), and the
next push to `master` will overwrite it.

## What rollback does NOT roll back

**D1 migrations.** `wrangler rollback` and a re-deploy both move the Worker's code
only. Every migration in `drizzle/` that has already been applied to the remote
`devinyl` database stays applied. There is no "rollback the schema" step here and
there is deliberately no down-migration mechanism.

That is safe because of one rule, which is the reason the rule exists:

> **Migrations are additive-only between releases.** A migration may add tables,
> add columns, add indexes. It may not drop or rename a column or table, or add a
> `NOT NULL` column without a default, in the same release as the code that needs
> it.

Where it's enforced:

- **Ordering** — `.github/workflows/ci.yml`'s `deploy` job runs
  `wrangler d1 migrations apply devinyl --remote` **before** `wrangler deploy`, so
  new columns exist before the code reading them ships. The consequence of that
  ordering is that there is always a window where new schema is live under old
  code, which only works if the schema is additive.
- **Never on boot** — migrations run in CI only, never at Worker startup (plan
  S.4). No deploy or rollback can trigger one as a side effect.
- **Review** — nothing mechanical rejects a destructive migration; the check is
  reading `drizzle/*.sql` in the PR. A `DROP COLUMN` in a migration is the one
  thing that makes rollback unsafe, so it is worth stopping on.

Follow the rule and a rollback is always safe: the old code runs happily against a
newer, wider schema, ignoring the columns it doesn't know about.

**If a destructive migration did ship** and you need the data back, `wrangler
rollback` will not help. That is a D1 Time Travel restore, not a rollback — see
`docs/runbooks/restore.md` (plan task 4.7).

Also not rolled back: `wrangler secret` values, Cron Trigger schedules removed from
`wrangler.jsonc` in a later deploy, and anything set through the Cloudflare
dashboard.

## Verifying recovery

```sh
# 1. Health endpoint — 200 + {"ok":true,...}; 503 means D1 is the problem, not code
curl -i https://devinyl.restless-mode-79fb.workers.dev/api/healthz

# 2. Confirm the version that's actually live
npx wrangler deployments status

# 3. Watch real traffic for errors
npx wrangler tail devinyl --status error
```

Leave `wrangler tail` running for a few minutes of real traffic before calling it
recovered — `/api/healthz` only proves the Worker boots and D1 answers, not that the
route that was 500ing is fixed. See `docs/runbooks/logs.md` for filtering and for
what the log lines mean.

If a Cron Trigger was implicated, wait for the next `*/15 * * * *` tick and confirm
the `[jobs:every-15-min] ...` lines appear in `wrangler tail` — a healthy fetch
handler says nothing about the `scheduled` one.
