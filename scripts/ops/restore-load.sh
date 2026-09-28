#!/usr/bin/env bash
# N08 (auditor recheck, 2026-09-27): load a plain pg_dump into an EMPTY database
# and print only what may be printed in a PUBLIC repository's Actions log.
#
# Run by BOTH .github/workflows/restore-drill.yml (the real production dump,
# monthly) and the restore-chain job in ci.yml (a synthetic one, every push), so
# the path the drill takes twelve times a year is exercised on every push.
#
# Why it exists: when a COPY, a CHECK or a unique-index build fails, PostgreSQL
# quotes the row it failed on — `DETAIL: Failing row contains (…)`, `CONTEXT:
# COPY Customer, line 812: "<the whole row>"`, `Key (col)=(value) is duplicated`.
# The drill printed `tail -40` of that log and up to twenty raw ERROR lines into
# the job log and uploaded the whole log as a 90-day artifact. The repository is
# public: anyone can read its Actions logs and any signed-in GitHub user can
# download its artifacts.
#
# So the raw log never reaches stdout, stderr or an artifact:
#   1. psql writes it to restore.log (mode 600) and nothing reads it but step 2;
#   2. scripts/ops/restore-log-summary.ts prints an allowlisted summary — phase,
#      dump line, severity, SQLSTATE, statement kind, a schema table name — and
#      appends the same as a table to the step summary;
#   3. the full log is encrypted with age to BACKUP_AGE_RECIPIENTS as
#      restore.log.age, the only form in which it may be uploaded;
#   4. the plaintext is shredded on every exit path, success or failure.
#
# Environment:
#   RESTORE_TARGET_URL     the database to load into (required, and it must be empty)
#   RESTORE_DUMP           the gzipped plain dump (default ./dump.sql.gz)
#   BACKUP_AGE_RECIPIENTS  age public key(s), comma separated. When unset the full
#                          log is discarded and only the summary is kept.
#
# Writes restore.log.age in the current directory. Exit status: 0 the load was
# clean; 1 it was not, or the log could not be sealed.
set -euo pipefail

: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL is not set}"
case "${BASH_SOURCE[0]}" in */*) SELF_DIR="${BASH_SOURCE[0]%/*}" ;; *) SELF_DIR=. ;; esac
ROOT="$(cd "$SELF_DIR/../.." && pwd)"
DUMP="${RESTORE_DUMP:-./dump.sql.gz}"
LOG="${PWD}/restore.log"
SEALED="${PWD}/restore.log.age"

discard_plaintext() {
  if [ -e "$LOG" ]; then shred -u "$LOG" 2>/dev/null || rm -f "$LOG"; fi
}
trap discard_plaintext EXIT

umask 077
rm -f "$LOG" "$SEALED"

# ON_ERROR_STOP: the first failure is fatal, not a half-loaded database, and it is
# the last thing psql reports — which is what lets the summary itemise it alone.
# VERBOSITY=verbose puts the SQLSTATE on every server message. --echo-errors adds
# the failed statement, from which the summary takes the table.
LOAD_EXIT=0
gunzip -c "$DUMP" | psql "$RESTORE_TARGET_URL" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose --echo-errors > "$LOG" 2>&1 || LOAD_EXIT=$?

SUMMARY_EXIT=0
SUMMARY_ARGS=("$LOG" --psql-exit "$LOAD_EXIT")
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then SUMMARY_ARGS+=(--markdown "$GITHUB_STEP_SUMMARY"); fi
# From the repository root, where tsx and prisma/schema.prisma are. `node --import
# tsx` rather than `npx tsx`: one process instead of a chain of them, which on a
# Windows developer box is the difference between 3 and 24 seconds.
(cd "$ROOT" && node --import tsx scripts/ops/restore-log-summary.ts "${SUMMARY_ARGS[@]}") || SUMMARY_EXIT=$?

SEAL_FAILED=0
if [ -n "${BACKUP_AGE_RECIPIENTS:-}" ]; then
  AGE_ARGS=()
  IFS=',' read -ra RECIPIENTS <<< "$BACKUP_AGE_RECIPIENTS"
  for R in "${RECIPIENTS[@]}"; do
    R="${R//[[:space:]]/}"
    if [ -n "$R" ]; then AGE_ARGS+=(-r "$R"); fi
  done
  if [ "${#AGE_ARGS[@]}" -gt 0 ] && age "${AGE_ARGS[@]}" -o "$SEALED" "$LOG"; then
    echo "full restore log kept only as restore.log.age, encrypted to $(( ${#AGE_ARGS[@]} / 2 )) recipient key(s)"
  else
    rm -f "$SEALED"
    SEAL_FAILED=1
    echo "::error::the restore log could not be encrypted to BACKUP_AGE_RECIPIENTS, so it is discarded unread; only the summary above remains"
  fi
else
  echo "::warning::BACKUP_AGE_RECIPIENTS is not set, so the full restore log cannot be kept encrypted and is discarded; only the summary above remains"
fi

discard_plaintext

if [ "$LOAD_EXIT" -ne 0 ] || [ "$SUMMARY_EXIT" -ne 0 ]; then
  if [ -e "$SEALED" ]; then WHERE='the full log is the restore.log.age artifact (decrypt it with the age identity, never into a public place)'; else WHERE='the full log was not kept'; fi
  echo "::error::the restore failed or reported errors (psql exit ${LOAD_EXIT}); the summary above names the dump line, SQLSTATE and table, and ${WHERE}"
  exit 1
fi
if [ "$SEAL_FAILED" -ne 0 ]; then exit 1; fi
