#!/usr/bin/env bash
# Is the database the nightly backup just dumped the one the app writes to?
# (code review 2026-11-10, finding 14.)
#
#   bash scripts/ops/backup-freshness.sh <secondsSinceNewestWrite> <event name>
#
# WHY. Every disaster-recovery runbook ends with production on a new host. The
# runbooks repointed Vercel only; the backup reads the separate GitHub DIRECT_URL
# secret, so it went on dumping the OLD, dead database every night and reporting
# "backup ok", every light green. The manifest (scripts/ops/backup-manifest.sql)
# now records how long ago the newest record was written — the newest audit row
# or the newest scheduled-job heartbeat — and this decides what that means.
#
# THE RULE, and why it does not cry wolf on a quiet database. A database nobody
# uses (before launch, a holiday) writes no audit rows for days. But the app's own
# scheduled jobs (vercel.json crons: keep-warm every 4 minutes 03:00–15:00 UTC,
# SLA sweep, e-mail drain, and four nightly jobs) stamp "CronHeartbeat" on the
# database the app uses whatever the users do, so on the live database the newest
# write is a few hours old at most (about 11 h at a 02:00 UTC backup). Only a
# database the app no longer writes to — or an app whose scheduled jobs have all
# stopped, which /api/health already alarms on — goes past MAX_QUIET_HOURS.
#
#   - A SCHEDULED run (event `schedule`) older than MAX_QUIET_HOURS fails, with a
#     plain message: the dump has already been uploaded (nothing is lost), the run
#     goes red and the dead-man report says the backup failed.
#   - A run by hand (`workflow_dispatch`) only warns, and always prints the age, so
#     the runbooks' "run the backup by hand and check the newest record is today"
#     step can be done right after a restore without a red run.
#   - No value (no manifest, an empty database): a scheduled run fails — it cannot
#     show the database is live; a hand run warns.
#
# Exit 0 fine (or warned), 1 failed. Prints GitHub annotations; never a URL.
# tests/unit/backup-freshness.test.ts runs it.
set -uo pipefail

# More than a day: the review's rule. A live database's newest write is ~11 h old
# at worst; a full missed day of every scheduled job is already an incident.
MAX_QUIET_HOURS=24

SECONDS_SINCE="${1:-}"
EVENT="${2:-}"

fail_or_warn() {
  if [ "$EVENT" = "schedule" ]; then
    echo "::error::$1"
    exit 1
  fi
  echo "::warning::$1 (A run by hand only warns; the nightly run fails on this.)"
  exit 0
}

if ! [[ $SECONDS_SINCE =~ ^-?[0-9]+$ ]]; then
  fail_or_warn "The backup could not tell how old the newest record in this database is (no manifest, or no audit row and no scheduled-job heartbeat at all), so it cannot show that this is the database the app uses. The dump was uploaded. Check that the GitHub DIRECT_URL secret names the host on the first line of config/production-hosts.txt (docs/OPERATIONS.md, Runbook A)."
fi

# A clock a little ahead of the database's: as fresh as it gets.
if [ "$SECONDS_SINCE" -lt 0 ]; then SECONDS_SINCE=0; fi
HOURS=$((SECONDS_SINCE / 3600))
echo "newest record in the dumped database: ${HOURS} h ago (limit ${MAX_QUIET_HOURS} h)"

if [ "$SECONDS_SINCE" -le $((MAX_QUIET_HOURS * 3600)) ]; then
  echo "::notice::the newest record in this database is ${HOURS} h old: it is the database the app writes to."
  exit 0
fi

fail_or_warn "The newest record in the database this backup dumped is ${HOURS} hours old. The app's scheduled jobs write to the database it uses every few minutes during the day, even when nobody signs in, so this is almost certainly a database the app no longer uses — the OLD host after a restore — or every scheduled job has stopped. The dump was uploaded, but it is probably not of production. Check that the GitHub DIRECT_URL secret and the first line of config/production-hosts.txt both name the host Vercel's DATABASE_URL uses (docs/OPERATIONS.md, Runbook A, 'Point the guards and the backup at the new host'), and the cron section of /api/health."
