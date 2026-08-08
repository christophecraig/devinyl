# Runbook: restoring the D1 database

Plan task 4.7. Two independent recovery paths exist for the remote `devinyl`
D1 database (`ac4591bc-d99a-41ba-bf27-1ce69e2b8222`): Cloudflare's built-in
Time Travel, and re-import from a `wrangler d1 export` snapshot. Backups
themselves come from `.github/workflows/backup.yml` — see "Where backups
live" below.

## 1. Decide which path

|          | Time Travel                                                                                                          | Snapshot re-import                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Window   | Last 30 days                                                                                                         | Anything a snapshot exists for (R2 retains indefinitely; Actions artifacts expire after ~30 days)                                    |
| Scope    | Whole database, restored in place                                                                                    | Whatever the snapshot contains — same whole-DB granularity, but into a **fresh** database (see caveat below)                         |
| Speed    | Fast — a Cloudflare-side operation, no data transfer                                                                 | Slower — download, gunzip, re-execute the full SQL file                                                                              |
| Use when | Recovering from something that happened recently (bad migration, bad deploy, accidental data loss) — the common case | Time Travel's 30-day window has passed, or you need to stand up a copy in a different database/account without touching the live one |

Default to Time Travel unless it can't cover what you need.

## 2. Time Travel (point-in-time, last 30 days)

**Always capture the current bookmark first** — it is the undo button for
the restore you're about to do:

```sh
pnpm exec wrangler d1 time-travel info devinyl
```

Note the bookmark it prints. If you skip this and the restore turns out to
be wrong, you have no direct way back to "right before I ran this."

Then restore to either a timestamp or a bookmark:

```sh
# By timestamp (Unix seconds or RFC3339, must be within the last 30 days)
pnpm exec wrangler d1 time-travel restore devinyl --timestamp=2026-08-06T12:00:00Z

# By bookmark (e.g. one captured by `info` above, or from `d1 time-travel restore`'s own output)
pnpm exec wrangler d1 time-travel restore devinyl --bookmark=<bookmark>
```

This acts on the remote database directly — no `--remote` flag needed (there
is no local equivalent).

**The restore itself is reversible.** Cloudflare gives the pre-restore state
its own bookmark as part of the restore operation, so if the restore target
turns out to be wrong, run `d1 time-travel restore devinyl
--bookmark=<pre-restore-bookmark>` (the one you captured in step 1, or the
one the restore command printed) to go back.

**Migration caveat:** if you restore to a point before a Drizzle migration
was applied, the restored database is missing that migration's schema
changes. The `deploy` job in `.github/workflows/ci.yml` runs `wrangler d1
migrations apply devinyl --remote` before every deploy, so the next push to
`master` re-applies whatever migrations are missing — as long as all
migrations in `drizzle/` stay additive-only (no destructive/renaming
migration should ever be written, precisely so this recovery path keeps
working). No manual migration replay should be needed.

## 3. Snapshot re-import (>30 days, or a separate database)

Fetch the snapshot, from whichever copy is available:

```sh
# From R2
pnpm exec wrangler r2 object get devinyl-backups/devinyl-2026-08-06.sql.gz --file devinyl-2026-08-06.sql.gz --remote

# Or download the matching GitHub Actions artifact from the backup.yml run
# ("devinyl-backup-2026-08-06") via the Actions UI or `gh run download`
```

```sh
gunzip devinyl-2026-08-06.sql.gz
```

**Caveat — target a fresh database, not the live one.** `wrangler d1 export`
includes `CREATE TABLE` statements for the whole schema. Running that file
against the live `devinyl` database with `wrangler d1 execute` will collide
with the tables that already exist. Re-import instead into a **new** D1
database:

```sh
pnpm exec wrangler d1 create devinyl-restored
# note the new database_id it prints, then either:
#  - temporarily repoint wrangler.jsonc's d1_databases[0].database_id to it, or
#  - pass --database (binding/name) explicitly if the CLI version supports it
pnpm exec wrangler d1 execute devinyl-restored --remote --file=devinyl-2026-08-06.sql
```

Once verified, use the standard D1/wrangler.jsonc process to promote the
restored database (repoint `database_id` in `wrangler.jsonc`, commit, deploy)
if it is meant to replace the live one — that is a deliberate, reviewed
change, not part of this runbook's recovery steps.

## 4. Verification (after either path)

```sh
# Confirms the Worker can reach D1 at all
curl -s https://<worker-url>/api/healthz

# Spot-check row counts against what you expect post-restore
pnpm exec wrangler d1 execute devinyl --remote --command "SELECT count(*) FROM <table>"
```

Compare counts against a known-good baseline (e.g. the row counts noted at
the time the snapshot/bookmark was taken, if available) rather than just
"non-zero" — a restore that silently landed on the wrong point in time can
still return a plausible-looking count.

## Where backups live

`.github/workflows/backup.yml` runs `wrangler d1 export devinyl --remote`
daily (03:17 UTC — chosen to avoid the `*/15 * * * *`, `0 * * * *`, and
`5 0 * * *` Cron Triggers in `wrangler.jsonc`), gzips the result, and writes
two independent copies:

- R2 bucket `devinyl-backups` (`wrangler r2 object put ... --remote`) — no
  automatic pruning; the database is tiny relative to R2's 10 GB free tier,
  so old snapshots are left in place. Revisit if that stops being true.
- A GitHub Actions artifact on the workflow run itself, retained ~30 days —
  an independent copy that survives even if the R2 upload is failing (see
  that workflow's header comment for the one-time API-token permission fix
  this depends on).

`workflow_dispatch` is also enabled on `backup.yml`, so an on-demand snapshot
can be triggered from the Actions tab before a risky operation (e.g. right
before a manual migration or a Time Travel restore drill).

## Drill log

Record every restore actually executed — drills and real incidents alike —
so the 30-day Time Travel window and backup freshness stay verified, not
assumed.

| Date       | Operator              | Path exercised         | Result                                                                                                                                                                                                                                                         |
| ---------- | --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-07 | Claude (orchestrator) | Time Travel, prep only | `info` verified live: current bookmark `00000182-00000000-000050c0-82f91d71dca4558425c1156aa989533f` captured. The actual `restore --timestamp` execution needs a human green light (it rewrites the remote DB) — run it once pre-launch and log the row here. |
