#!/usr/bin/env bash
# Go-live clean start: the RUN FLOW's shell half (design sections 0, 2-9).
#
# .github/workflows/clean-start.yml and clean-start-photos.yml call this file
# between their database steps. It never opens a database itself: every
# database command is written out in the workflow file, its output goes to a
# file under CS_DIR, and this file then reads that file and prints only what a
# PUBLIC Actions log may show (design section 8):
#
#   step names, "<label>: yes|no" lines, SQLSTATE codes, check ids with their
#   statuses, durations and hashes (12, 16 or 64 hex).
#
# Never a count, a name, an object key, a connection string or a secret: those
# exist only in the age-encrypted reports under cleanstart/<runId>/ in the
# backups bucket and in the reset's own AuditLog row (in-app).
# tests/unit/clean-start-run.test.ts and tests/integration/clean-start-flow.test.ts
# hold every subcommand to that.
#
# Why the database commands are not in here: tests/unit/scripts-production-guard.test.ts
# requires every shell script under scripts/ that names a database client to be
# listed, with what stands in for the guard, in that test's own registry, and
# that test may not be edited by this work. So the workflow holds those lines
# and this file holds everything else. The targets are still checked first,
# here, through the shared host list (scripts/ops/production-hosts.sh) and
# target-guard.sh: prod-target before every production step, rehearse-target
# before every copy.
#
# Usage: bash scripts/ops/clean-start/run.sh <subcommand> [args]   (see dispatch at the end)
#
# Environment (each subcommand names what it reads): CS_DIR (private work
# folder, set by the workflow from RUNNER_TEMP; refused when missing), GITHUB_* (set by Actions),
# BACKUP_R2_* and CLEANSTART_R2_* (storage), BACKUP_AGE_RECIPIENTS /
# BACKUP_AGE_IDENTITY, NEON_API_KEY / NEON_PROJECT_ID, HEALTH_BEARER,
# PROD_CRON_SECRET, APP_BASE_URL, GH_TOKEN.
set -euo pipefail
umask 077

case "${BASH_SOURCE[0]}" in */*) CS_HERE="${BASH_SOURCE[0]%/*}" ;; *) CS_HERE=. ;; esac
CS_ROOT="$(cd "$CS_HERE/../../.." && pwd)"
# shellcheck source=../production-hosts.sh
. "$CS_HERE/../production-hosts.sh"

NEON_API="${NEON_API_BASE:-https://console.neon.tech/api/v2}"
GH_API="${GITHUB_API_URL:-https://api.github.com}"
PHOTO_KEY_RE='^[0-9]{4}/[0-9]{2}/[0-9]{2}/[A-Za-z0-9]+/[A-Z_]+/[0-9a-f-]{36}\.(jpg|png|webp)$'

# ---------------------------------------------------------------- output ----

# One line to the log, and the same as a list item in the step summary.
say() {
  printf '%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- %s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}
# yes_no <label> <0|1>: "label: yes" when the second argument is 0 (a shell truth).
yes_no() {
  if [ "$2" -eq 0 ]; then say "$1: yes"; else say "$1: no"; fi
}
step() { say "STEP $*"; }
# A refusal: one fixed sentence (never a value), then exit 1.
refuse() {
  echo "::error::clean start refused: $1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- **refused: %s**\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 1
}
set_out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi; }
set_env() { if [ -n "${GITHUB_ENV:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV"; fi; }
short() { printf '%s' "${1:0:12}"; }
sha_file() { sha256sum < "$1" | cut -d' ' -f1; }
need() {
  local v
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then refuse "the setting $v is missing"; fi
  done
}
# CS_DIR: the private work folder, set by the workflow's first step from
# RUNNER_TEMP. No default: an unset, empty or relative value would put the
# plaintext (and shred's removal) somewhere else, so it is refused. A drive path
# (C:/... or C:\...) is accepted only when bash itself runs on Windows (the local
# tests); on Linux, as on the hosted runner, "C:x" or "C:/x" is relative.
case "${CS_DIR:-}" in
  /?*) ;;
  [A-Za-z]:/?* | [A-Za-z]:\\?*)
    case "$(uname -s 2>/dev/null)" in
      MINGW* | MSYS* | CYGWIN*) ;;
      *) refuse "the private work folder is not set, or not an absolute path" ;;
    esac ;;
  *) refuse "the private work folder is not set, or not an absolute path" ;;
esac
mkdir -p "$CS_DIR"
chmod 700 "$CS_DIR" 2>/dev/null || true

oman_date() { date -u -d "@$(( $(date -u +%s) + 4 * 3600 ))" +%Y-%m-%d; }
run_id() {
  local r="${GITHUB_RUN_ID:-}"
  [[ $r =~ ^[0-9]{1,20}$ ]] || refuse "the run id is not a GitHub run id"
  printf '%s' "$r"
}
# A run id the owner typed (finish, seal-restore, photos): digits only.
typed_run_id() {
  [[ ${1:-} =~ ^[0-9]{1,20}$ ]] || refuse "run_id must be the number of the apply run"
  printf '%s' "$1"
}

# ------------------------------------------------------------- storage ----
# aws-cli against R2, one credential per bucket and purpose, set per call so a
# step never holds a write token it does not use. Nothing aws prints reaches
# the log: its stdout and stderr go to $CS_DIR/aws.log.

backups_endpoint() { printf 'https://%s.r2.cloudflarestorage.com' "$BACKUP_R2_ACCOUNT_ID"; }
photos_endpoint() { printf 'https://%s.r2.cloudflarestorage.com' "$PHOTOS_R2_ACCOUNT_ID"; }
aws_backups() {
  AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
    aws "$@" --endpoint-url "$(backups_endpoint)" 2>> "$CS_DIR/aws.log"
}
aws_photos_ro() {
  AWS_ACCESS_KEY_ID="$CLEANSTART_R2_RO_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$CLEANSTART_R2_RO_SECRET_ACCESS_KEY" \
    aws "$@" --endpoint-url "$(photos_endpoint)" 2>> "$CS_DIR/aws.log"
}
aws_photos_rw() {
  AWS_ACCESS_KEY_ID="$CLEANSTART_R2_RW_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$CLEANSTART_R2_RW_SECRET_ACCESS_KEY" \
    aws "$@" --endpoint-url "$(photos_endpoint)" 2>> "$CS_DIR/aws.log"
}
# list_keys <ro|rw|backups> <bucket> <prefix> > file: every key under the prefix, sorted (C).
list_keys() {
  local who="$1" bucket="$2" prefix="$3" raw
  raw="$("aws_$who" s3api list-objects-v2 --bucket "$bucket" --prefix "$prefix" --query 'Contents[].Key' --output text)" || return 1
  printf '%s\n' "$raw" | tr '\t' '\n' | grep -v -x -e '' -e 'None' | LC_ALL=C sort || true
}

# ----------------------------------------------------------- encryption ----

age_args() {
  AGE_ARGS=()
  local r
  IFS=',' read -ra _rs <<< "${BACKUP_AGE_RECIPIENTS:-}"
  for r in "${_rs[@]}"; do
    r="${r//[[:space:]]/}"
    if [ -n "$r" ]; then AGE_ARGS+=(-r "$r"); fi
  done
  [ "${#AGE_ARGS[@]}" -gt 0 ] || refuse "BACKUP_AGE_RECIPIENTS is not set, so nothing could be stored encrypted"
}
with_identity() {
  need BACKUP_AGE_IDENTITY
  local key="$CS_DIR/age.key"
  printf '%s' "$BACKUP_AGE_IDENTITY" > "$key"
  chmod 600 "$key"
  local rc=0
  "$@" "$key" || rc=$?
  shred -u "$key" 2>/dev/null || rm -f "$key"
  return "$rc"
}
_decrypt() { age -d -i "$3" -o "$2" "$1"; }

# --------------------------------------------------------------- http ----
# http <out file> <url> [curl args...]: prints the status code only; the body
# stays in the file. Never prints the URL (it may carry a project id).
http() {
  local out="$1" url="$2"
  shift 2
  curl -s -o "$out" -w '%{http_code}' --max-time 60 "$@" "$url" 2>> "$CS_DIR/curl.log" || printf '000'
}
gh_get() {
  need GH_TOKEN GITHUB_REPOSITORY
  http "$1" "$GH_API/repos/$GITHUB_REPOSITORY/$2" \
    -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28'
}
neon() {
  local method="$1" out="$2" path="$3"
  shift 3
  need NEON_API_KEY NEON_PROJECT_ID
  http "$out" "$NEON_API/projects/$NEON_PROJECT_ID$path" -X "$method" \
    -H "Authorization: Bearer $NEON_API_KEY" -H 'Accept: application/json' -H 'Content-Type: application/json' "$@"
}

# ============================================================ subcommands ===

# preflight <job>: the settings this JOB reads exist (names only), and the run
# is on the default branch; for the apply job also the evening window. The
# plan job is "plan" in every mode (it then calls window itself in mode apply).
cmd_preflight() {
  local mode="${1:-}"
  local common=(PROD_URL_RAW CONFIRM_HOST)
  local names=()
  case "$mode" in
    plan) names=("${common[@]}" CLEANSTART_ACTOR_USERNAME HEALTH_BEARER BACKUP_AGE_RECIPIENTS BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY CLEANSTART_R2_RO_ACCESS_KEY_ID CLEANSTART_R2_RO_SECRET_ACCESS_KEY GH_TOKEN) ;;
    neon-rehearsal) names=(CLEANSTART_ACTOR_USERNAME NEON_API_KEY NEON_PROJECT_ID CLEANSTART_R2_RO_ACCESS_KEY_ID CLEANSTART_R2_RO_SECRET_ACCESS_KEY) ;;
    apply) names=("${common[@]}" CONFIRM_PHRASE CLEANSTART_ACTOR_USERNAME HEALTH_BEARER PROD_CRON_SECRET BACKUP_AGE_RECIPIENTS BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY CLEANSTART_R2_RO_ACCESS_KEY_ID CLEANSTART_R2_RO_SECRET_ACCESS_KEY CLEANSTART_R2_RW_ACCESS_KEY_ID CLEANSTART_R2_RW_SECRET_ACCESS_KEY NEON_API_KEY NEON_PROJECT_ID GH_TOKEN) ;;
    finish) names=("${common[@]}" HEALTH_BEARER PROD_CRON_SECRET BACKUP_AGE_RECIPIENTS BACKUP_AGE_IDENTITY BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY CLEANSTART_R2_RO_ACCESS_KEY_ID CLEANSTART_R2_RO_SECRET_ACCESS_KEY CLEANSTART_R2_RW_ACCESS_KEY_ID CLEANSTART_R2_RW_SECRET_ACCESS_KEY NEON_API_KEY NEON_PROJECT_ID GH_TOKEN) ;;
    seal-restore) names=("${common[@]}" PROD_CRON_SECRET BACKUP_AGE_RECIPIENTS BACKUP_AGE_IDENTITY BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY CLEANSTART_R2_RO_ACCESS_KEY_ID CLEANSTART_R2_RO_SECRET_ACCESS_KEY CLEANSTART_R2_RW_ACCESS_KEY_ID CLEANSTART_R2_RW_SECRET_ACCESS_KEY GH_TOKEN) ;;
    photos) names=("${common[@]}" CONFIRM_PHRASE CLEANSTART_ACTOR_USERNAME BACKUP_AGE_RECIPIENTS BACKUP_AGE_IDENTITY BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY CLEANSTART_R2_RW_ACCESS_KEY_ID CLEANSTART_R2_RW_SECRET_ACCESS_KEY NEON_API_KEY NEON_PROJECT_ID GH_TOKEN) ;;
    *) refuse "the job is not one of plan, neon-rehearsal, apply, finish, seal-restore, photos" ;;
  esac
  local missing=0 v
  for v in "${names[@]}"; do
    if [ -z "${!v:-}" ]; then
      say "setting $v present: no"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || refuse "a setting this mode needs is missing (named above)"
  say "every setting this job needs is present: yes"

  # The default branch only: what runs is what was reviewed and merged.
  [ -n "${DEFAULT_BRANCH:-}" ] || refuse "the default branch is unknown"
  [ "${GITHUB_REF:-}" = "refs/heads/$DEFAULT_BRANCH" ] || refuse "the run is not on the default branch"
  say "run on the default branch: yes"

  if [ "$mode" = apply ]; then cmd_window; fi
}

# window: apply only between 15:30 and 23:30 UTC (19:30-03:30 Oman): no
# scheduled job of vercel.json is due then (design 9). GitHub's own schedules
# (sla-escalate.yml, keep-warm.yml) are due before 15:00 UTC too, but GitHub can
# start a run hours late, so the owner's guide has both disabled for the reset
# evening (Step 5) and enabled again the next morning (Step 6).
cmd_window() {
  local hm
  hm="$(date -u +%H%M)"
  hm=$((10#$hm))
  if [ "$hm" -ge 1530 ] && [ "$hm" -le 2330 ]; then
    say "inside the evening window (15:30-23:30 UTC): yes"
  else
    say "inside the evening window (15:30-23:30 UTC): no"
    refuse "apply runs only between 15:30 and 23:30 UTC"
  fi
}

# prod-target <read|apply|photos>: PROD_URL_RAW is production now, named by the
# owner. Cleans the pasted secret (as db-backup.yml does) and hands it on as
# DIRECT_URL for the following steps. apply also runs target-guard.sh apply
# (the typed phrase), immediately before the reset.
cmd_prod_target() {
  local how="${1:-read}" clean host marker
  need PROD_URL_RAW
  clean="$(printf '%s' "$PROD_URL_RAW" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$clean" in
    postgresql://* | postgres://*) ;;
    *) refuse "DIRECT_URL is not a postgresql connection string" ;;
  esac
  case "$clean" in
    *[?\&]host=* | *[?\&]hostaddr=*) refuse "DIRECT_URL carries a host parameter, which would override its host" ;;
  esac
  if [ -n "${PGHOST:-}" ] || [ -n "${PGHOSTADDR:-}" ]; then refuse "PGHOST or PGHOSTADDR is set"; fi
  production_hosts_load || exit 2
  host="$(pg_url_host "$clean")"
  case "$host" in
    "${PRODUCTION_HOSTS[0]}"*) ;;
    *) refuse "DIRECT_URL is not production now (the first line of config/production-hosts.txt)" ;;
  esac
  marker="${PRODUCTION_HOSTS[0]}"
  [ "$(printf '%s' "${CONFIRM_HOST:-}" | tr '[:upper:]' '[:lower:]')" = "$marker" ] || refuse "confirm_host does not name the production host"
  if [ "$how" = apply ]; then
    DIRECT_URL="$clean" bash "$CS_HERE/target-guard.sh" apply > "$CS_DIR/target-guard.out" 2>&1 \
      || refuse "the target guard refused (production, confirm_host and the phrase are checked together)"
  elif [ "$how" = photos ]; then
    [ "${CONFIRM_PHRASE:-}" = "DELETE TEST PHOTOS" ] || refuse "confirm_phrase is not exactly DELETE TEST PHOTOS"
  fi
  # The cleaned string can differ from the secret GitHub masks (a pasted space or
  # line end), and GITHUB_ENV values show in every later step's env header.
  echo "::add-mask::$clean"
  set_env DIRECT_URL "$clean"
  say "connection is production, named by the owner: yes"
}

# rehearse-target <url env name>: a copy, never production (target-guard.sh rehearse).
cmd_rehearse_target() {
  local name="${1:-REHEARSE_URL}"
  local url="${!name:-}"
  [ -n "$url" ] || refuse "the rehearsal connection string is missing"
  DIRECT_URL="$url" bash "$CS_HERE/target-guard.sh" rehearse > "$CS_DIR/target-guard.out" 2>&1 \
    || refuse "the rehearsal target is production, or could not be checked"
  say "rehearsal target is not production: yes"
}

# sql <label> <exit code> <output file>: what a database step did, by exit code
# and SQLSTATE only (VERBOSITY sqlstate; the output file is never printed).
# Exits with the same code, so the workflow step fails when the step did.
cmd_sql() {
  local label="$1" rc="$2" out="$3" codes
  if [ "$rc" -eq 0 ]; then
    say "$label: ok"
    return 0
  fi
  codes="$(grep -oE '(ERROR|FATAL):  [0-9A-Z]{5}' "$out" 2>/dev/null | awk '{print $2}' | LC_ALL=C sort -u | tr '\n' ' ' || true)"
  case "$rc" in
    2) say "$label: no connection (the outcome is unknown)" ;;
    3) say "$label: refused, rolled back" ;;
    *) say "$label: failed" ;;
  esac
  local c
  for c in $codes; do say "$label: SQLSTATE $c"; done
  exit "$rc"
}

# bool <label> <file> [ask]: a one-line t/f answer of a read-only query. A "no"
# refuses (the bold "refused: <label>: no" line the owner's guide points to),
# unless the third argument is "ask": then it only returns 1 (a question the
# workflow branches on).
cmd_bool() {
  local label="$1" file="$2" how="${3:-}" v
  v="$(tr -d '\r[:space:]' 2>/dev/null < "$file" || true)"
  if [ "$v" = t ]; then say "$label: yes"; return 0; fi
  say "$label: no"
  [ "$how" = ask ] && return 1
  refuse "$label: no"
}

# owner-facts <file>: the PLAN facts the owner's questions need (design
# facts_to_check_in_production, "CronRun ... PLAN, yes/no"), recorded, never
# refusing. The file holds three t/f lines from facts.sql owner-facts.
cmd_owner_facts() {
  local f="$1" a b c
  { read -r a; read -r b; read -r c; } < <(tr -d '\r' < "$f") || true
  yes_no "job runs recorded for yesterday in Oman" "$([ "${a:-}" = t ]; echo $?)"
  yes_no "job runs recorded for today in Oman" "$([ "${b:-}" = t ]; echo $?)"
  yes_no "a windowed job ran outside 03:00-15:00 UTC in the last 3 days" "$([ "${c:-}" = t ]; echo $?)"
}

# exports <dir> [expected plan id] [label] [record]: the PLAN files bound to
# their plan id. Line ends normalised (the Windows client writes CRLF; a key, and
# the JSON of a seal body, can hold no raw CR). Sets outputs plan_id,
# old_chain, photo_keys_sha256. With an expected id: "<label>: yes|no", and a
# difference fails the step unless the fourth argument is "record".
cmd_exports() {
  local dir="$1" want="${2:-}" label="${3:-same plan id as the production plan}" how="${4:-}" f k v
  for f in photo-keys.txt seals.jsonl plan.json plan-id.txt; do
    [ -f "$dir/$f" ] || refuse "the plan did not write $f"
    tr -d '\r' < "$dir/$f" > "$dir/$f.lf" && mv "$dir/$f.lf" "$dir/$f"
  done
  declare -A ids=()
  while IFS='=' read -r k v; do [ -n "$k" ] && ids[$k]="$v"; done < "$dir/plan-id.txt"
  [[ ${ids[plan_id]:-} =~ ^[0-9a-f]{64}$ ]] || refuse "the plan id is malformed"
  [[ ${ids[old_chain]:-} =~ ^([0-9a-f]{16}|none)$ ]] || refuse "the old chain id is malformed"
  local ok=0
  [ "$(sha_file "$dir/photo-keys.txt")" = "${ids[photo_keys_sha256]:-}" ] || ok=1
  [ "$(sha_file "$dir/seals.jsonl")" = "${ids[seals_sha256]:-}" ] || ok=1
  yes_no "exports match the plan" "$ok"
  [ "$ok" -eq 0 ] || refuse "the exported files are not the ones the plan id binds"
  say "plan id: $(short "${ids[plan_id]}")"
  set_out plan_id "${ids[plan_id]}"
  set_out old_chain "${ids[old_chain]}"
  set_out photo_keys_sha256 "${ids[photo_keys_sha256]}"
  printf '%s' "${ids[plan_id]}" > "$dir/.plan_id"
  if [ -n "$want" ]; then
    if [ "${ids[plan_id]}" = "$want" ]; then
      say "$label: yes"
    else
      say "$label: no"
      [ "$how" = record ] || refuse "$label: no"
    fi
  fi
}

# settle <exit code of verify.sql> <its output>: did the reset commit? (APPLY
# step e, and mode finish.) CS301 alone = the reset row is not there: nothing
# changed. A later check failing (CS302-CS307, which verify.sql reaches only
# after CS301 passed) = committed, not verified. Anything else (an error before
# CS301 was decided, a lost connection) = unknown. Writes CS_COMMITTED
# (yes|no|unknown) to $CS_DIR/committed and the job environment. Exit 0 only
# when committed AND verified.
cmd_settle() {
  local rc="$1" out="$2" codes state c later=1
  codes="$(grep -oE '(ERROR|FATAL):  [0-9A-Z]{5}' "$out" 2>/dev/null | awk '{print $2}' | LC_ALL=C sort -u | tr '\n' ' ' || true)"
  codes="${codes% }"
  if [ -n "$codes" ]; then
    later=0
    for c in $codes; do [[ $c =~ ^CS30[2-7]$ ]] || later=1; done
  fi
  if [ "$rc" -eq 0 ]; then
    state=yes
  elif [ "$rc" -eq 3 ] && [ "$codes" = CS301 ]; then
    state=no
  elif [ "$rc" -eq 3 ] && [ "$later" -eq 0 ]; then
    state=yes
  else
    state=unknown
  fi
  printf '%s\n' "$state" > "$CS_DIR/committed"
  set_env CS_COMMITTED "$state"
  case "$state" in
    yes) say "reset committed: yes" ;;
    no) say "reset committed: no (nothing changed)" ;;
    unknown)
      if [ "$rc" -eq 2 ]; then say "reset committed: unknown (no connection); run mode finish with this run id"
      else say "reset committed: unknown (the check did not finish); run mode finish with this run id"; fi
      ;;
  esac
  if [ "$state" = yes ] && [ "$rc" -eq 0 ]; then
    say "kept accounts, routes and regions verified after the reset: yes"
    return 0
  fi
  if [ "$state" = yes ]; then
    say "kept accounts, routes and regions verified after the reset: no"
    local c
    for c in $codes; do say "verify: SQLSTATE $c"; done
  fi
  exit 1
}

# record <label> <exit code>: yes/no, never failing (a recorded fact).
cmd_record() { yes_no "$1" "$2"; }

# status-lines <tsv> [refuse]: "checkId: status" for each line of a watch
# read-back. With "refuse" (mode seal-restore), a check failing or in error
# fails the step: the owner's guide treats every red job as "tell Claude".
#
# The one exception in seal-restore is seal-offsite-copies: the restore step
# has just hash-checked every old seal file back in place, so a failure there
# can only be objects under seals/ that are not production's chain (the test
# environment's, sharing the bucket), which the design accepts. It is shown
# and recorded, never a refusal.
cmd_status_lines() {
  local id st rest bad=1 other=1 offsite=1 seen=1
  while IFS=$'\t' read -r id st rest; do
    [[ $id =~ ^[a-z0-9-]{2,60}$ ]] || continue
    case "$st" in
      pass | info) ;;
      fail | error)
        bad=0
        if [ "$id" = seal-offsite-copies ] && [ "$st" = fail ]; then offsite=0; else other=0; fi
        ;;
      *) continue ;;
    esac
    seen=0
    say "$id: $st"
  done < <(tr -d '\r' < "$1")
  yes_no "a check failing or in error" "$bad"
  if [ "${2:-}" = refuse ]; then
    [ "$seen" -eq 0 ] || refuse "the integrity watch returned no results"
    [ "$offsite" -ne 0 ] || say "seal-offsite-copies failing only for objects outside the old chain (checked above): yes"
    [ "$other" -ne 0 ] || refuse "a check is failing or in error after the restore; tell Claude before anyone uses the CRM"
  fi
}

# check-run-id <typed>: a run id the owner typed is a number.
cmd_check_run_id() { typed_run_id "${1:-}" > /dev/null; say "run id given: yes"; }

# safety-name: the Neon safety branch's name, pre-clean-start-<Oman date>-<run>.
cmd_safety_name() { printf 'pre-clean-start-%s-%s' "$(oman_date)" "$(run_id)"; }

# for-the-owner <plan-id.txt> [run id]: the two values the photo step asks for
# (owner runbook, day 7): the run id and the photo-key list's sha256.
cmd_for_the_owner() {
  local sum r="${2:-${GITHUB_RUN_ID:-}}"
  sum="$(sed -n 's/^photo_keys_sha256=//p' "$1" | tr -d '\r')"
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || return 0
  [[ $r =~ ^[0-9]{1,20}$ ]] || return 0
  say "run_id for the photo step: $r"
  say "list_sha256 for the photo step: $sum"
  if [[ ${CS_RESET_STARTED:-} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    say "reset started at (UTC): $CS_RESET_STARTED"
    local s
    s="$(date -u -d "$CS_RESET_STARTED" +%s 2>/dev/null || true)"
    [[ $s =~ ^[0-9]+$ ]] && say "reset started at (Oman time): $(date -u -d "@$(( s + 4 * 3600 ))" '+%Y-%m-%d %H:%M')"
  fi
  return 0
}

# started: the moment the reset statement is sent, for the owner's rollback.
# Also leaves $CS_DIR/reset-started on disk BEFORE the statement is sent: if the step is
# cancelled or the runner lost, GITHUB_ENV may never be applied, and the
# cleanup must still know the reset may have reached the server (safety-cleanup).
cmd_started() {
  local t s
  s="$(date -u +%s)"
  t="$(date -u -d "@$s" +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$t" > "$CS_DIR/reset-started"
  set_env CS_RESET_STARTED "$t"
  say "reset started at (UTC): $t"
  say "reset started at (Oman time): $(date -u -d "@$(( s + 4 * 3600 ))" '+%Y-%m-%d %H:%M')"
}

# safety-cleanup: the apply job's always() decision about the Neon safety branch.
# Deleted ONLY when it is certain the reset did not commit: it never started
# (no marker on disk AND no CS_RESET_RC), Postgres refused it (exit 3, rolled
# back), or settle read CS301 ("no"). Everything else keeps it: it is the
# rollback. Reads the files as well as the job environment, since a cancelled
# step's GITHUB_ENV may be lost.
cmd_safety_cleanup() {
  local committed rc started=1
  # (stderr is silenced BEFORE the input redirect: a missing file must print nothing)
  committed="${CS_COMMITTED:-$(tr -d '\r[:space:]' 2>/dev/null < "$CS_DIR/committed" || true)}"
  rc="${CS_RESET_RC:-$(tr -d '\r[:space:]' 2>/dev/null < "$CS_DIR/reset-rc" || true)}"
  [ -f "$CS_DIR/reset-started" ] && started=0
  if [ "$committed" = no ] || [ "$rc" = 3 ] || { [ "$started" -ne 0 ] && [ -z "$rc" ]; }; then
    cmd_neon_cleanup
  else
    cmd_neon_forget
  fi
}

# chain-id <facts file> <run id>: production's NEW seal chain (the first 16 hex
# of the seq-0 seal's hash, facts.sql chain-id), stored encrypted under
# cleanstart/<run>/chain/ for mode seal-restore, which moves ONLY that chain's
# folder. Recorded, never refusing (the watch comparison decides the step).
cmd_chain_id() {
  local f="$1" r v
  r="$(typed_run_id "${2:-}")"
  v="$(tr -d '\r[:space:]' 2>/dev/null < "$f" || true)"
  if ! [[ $v =~ ^[0-9a-f]{16}$ ]]; then
    say "new seal chain id recorded: no"
    return 0
  fi
  printf 'new_chain=%s\n' "$v" > "$CS_DIR/new-chain.txt"
  printf '%s' "$v" > "$CS_DIR/new-chain"
  set_env NEW_CHAIN "$v"
  cmd_encrypt_upload "cleanstart/$r/chain" "$CS_DIR/new-chain.txt"
  say "new seal chain id recorded: yes"
}

# chain-id-fetch <run id>: the new chain id the apply (or finish) of that run
# recorded. seal-restore never guesses which objects under seals/ are
# production's new chain (the bucket is shared with other environments, whose
# own chains must never be touched). When none was recorded (apply stopped at
# step g or h, before a new first seal was written or before its id was read),
# NEW_CHAIN is "none": seal-archive.sh restore then still puts the old seal
# files back, moves nothing, and refuses if any chain folder under seals/ is
# one it cannot name.
cmd_chain_id_fetch() {
  local r v out="$CS_DIR/new-chain.txt"
  r="$(typed_run_id "${1:-}")"
  if ! aws_backups s3 cp "s3://$BACKUP_R2_BUCKET/cleanstart/$r/chain/new-chain.txt.age" "$out.age" > /dev/null; then
    rm -f "$out.age"
    set_env NEW_CHAIN none
    say "new seal chain id of that run recorded: no"
    return 0
  fi
  with_identity _decrypt "$out.age" "$out" || refuse "an encrypted export could not be decrypted"
  rm -f "$out.age"
  v="$(sed -n 's/^new_chain=//p' "$out" | tr -d '\r')"
  [[ $v =~ ^[0-9a-f]{16}$ ]] || refuse "the recorded new seal chain id is malformed"
  printf '%s' "$v" > "$CS_DIR/new-chain"
  set_env NEW_CHAIN "$v"
  say "new seal chain id of that run found: yes"
}

# finish-may <out file>: the objects under seals/ the FIRST watch run may have
# reported in mode finish, where that run may be a scheduled one made before
# this job removed the old seal files: everything seal-archive.sh verify listed
# now (other environments' objects and the old chain's files still there),
# except production's new chain ($CS_DIR/new-chain, when known).
cmd_finish_may() {
  local out="$1" new
  new="$(cat "$CS_DIR/new-chain" 2>/dev/null || true)"
  [ -f "$CS_DIR/seal-keys-foreign.txt" ] && [ -f "$CS_DIR/seal-keys-own.txt" ] || refuse "run seal-archive.sh verify first"
  if [[ $new =~ ^[0-9a-f]{16}$ ]]; then
    grep -v -F "seals/v1/$new/" "$CS_DIR/seal-keys-foreign.txt" > "$out" || true
  else
    cp "$CS_DIR/seal-keys-foreign.txt" "$out"
  fi
  cat "$CS_DIR/seal-keys-own.txt" >> "$out"
}

# health: production serves the commit this run checked out (/api/health,
# behind the monitor bearer, as smoke --expect-commit reads it).
cmd_health() {
  need HEALTH_BEARER APP_BASE_URL GITHUB_SHA
  local f="$CS_DIR/health.json" code commit
  code="$(http "$f" "${APP_BASE_URL%/}/api/health" -H "Authorization: Bearer $HEALTH_BEARER")"
  commit="$(jq -r '.commit // empty' "$f" 2>/dev/null || true)"
  rm -f "$f"
  case "$code" in 200 | 503) ;; *) refuse "the health endpoint did not answer" ;; esac
  if [ "$commit" = "${GITHUB_SHA:0:7}" ]; then
    say "production serves this run's commit: yes"
  else
    say "production serves this run's commit: no"
    refuse "production does not serve the commit this run checked out"
  fi
}

# github-env: the environment production-reset exists AND has a required
# reviewer (an environment GitHub created on first use has none).
cmd_github_env() {
  local f="$CS_DIR/gh-env.json" code n
  code="$(gh_get "$f" environments/production-reset)"
  [ "$code" = 200 ] || refuse "the environment production-reset could not be read"
  n="$(jq -r '[.protection_rules[]? | select(.type == "required_reviewers") | (.reviewers // []) | length] | add // 0' "$f")"
  rm -f "$f"
  if [[ $n =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ]; then
    say "environment production-reset has a required reviewer: yes"
  else
    say "environment production-reset has a required reviewer: no"
    refuse "environment production-reset has no required reviewer"
  fi
}

# backup-idle: no DB Backup run is queued or in progress.
cmd_backup_idle() {
  local s f="$CS_DIR/gh-runs.json" code n
  for s in in_progress queued; do
    code="$(gh_get "$f" "actions/workflows/db-backup.yml/runs?status=$s&per_page=1")"
    [ "$code" = 200 ] || refuse "the DB Backup runs could not be read"
    n="$(jq -r '.total_count // 0' "$f")"
    if [ "$n" != 0 ]; then
      say "no DB Backup run in progress: no"
      refuse "a DB Backup run is in progress; wait for it and start again"
    fi
  done
  rm -f "$f"
  say "no DB Backup run in progress: yes"
}

# neon-green [record]: a successful neon-rehearsal run of this workflow, within
# 14 days, ON THE DEFAULT BRANCH, whose scripts/ops/clean-start tree AND whose
# clean-start.yml are this checkout's (apply; "record" in a dry run only says
# yes or no, so a problem shows before reset day).
cmd_neon_green() {
  local how="${1:-}" mine mineyml since f="$CS_DIR/gh-cs.json" code id sha branch jobs okjobs tree yml found=1
  need DEFAULT_BRANCH
  mine="$(git -C "$CS_ROOT" rev-parse HEAD:scripts/ops/clean-start 2>/dev/null || true)"
  mineyml="$(git -C "$CS_ROOT" rev-parse HEAD:.github/workflows/clean-start.yml 2>/dev/null || true)"
  [[ $mine =~ ^[0-9a-f]{40}$ ]] && [[ $mineyml =~ ^[0-9a-f]{40}$ ]] || refuse "the checkout's clean-start tree could not be read"
  since="$(date -u -d "@$(( $(date -u +%s) - 14 * 86400 ))" +%Y-%m-%d)"
  code="$(gh_get "$f" "actions/workflows/clean-start.yml/runs?status=success&per_page=50&created=%3E%3D$since")"
  [ "$code" = 200 ] || refuse "the clean-start runs could not be read"
  while IFS=' ' read -r id sha branch; do
    [[ $id =~ ^[0-9]+$ ]] && [[ $sha =~ ^[0-9a-f]{40}$ ]] || continue
    [ "$branch" = "$DEFAULT_BRANCH" ] || continue
    jobs="$CS_DIR/gh-jobs.json"
    [ "$(gh_get "$jobs" "actions/runs/$id/jobs")" = 200 ] || continue
    okjobs="$(jq -r '[.jobs[]? | select(.name == "Neon rehearsal" and .conclusion == "success")] | length' "$jobs")"
    [ "$okjobs" = 1 ] || continue
    [ "$(gh_get "$jobs" "contents/scripts/ops?ref=$sha")" = 200 ] || continue
    tree="$(jq -r '.[]? | select(.name == "clean-start" and .type == "dir") | .sha' "$jobs")"
    [ "$(gh_get "$jobs" "contents/.github/workflows?ref=$sha")" = 200 ] || continue
    yml="$(jq -r '.[]? | select(.name == "clean-start.yml" and .type == "file") | .sha' "$jobs")"
    if [ "$tree" = "$mine" ] && [ "$yml" = "$mineyml" ]; then found=0; break; fi
  done < <(jq -r '.workflow_runs[]? | select(.display_title == "Clean start neon-rehearsal") | "\(.id) \(.head_sha) \(.head_branch)"' "$f")
  rm -f "$f" "$CS_DIR/gh-jobs.json"
  yes_no "green Neon rehearsal of these scripts within 14 days" "$found"
  [ "$found" -eq 0 ] || [ "$how" = record ] || refuse "no green neon-rehearsal of these exact scripts in the last 14 days"
}

# backup-pick <max hours> [must equal key]: the newest db/*.sql.gz.age in the
# backups bucket has a manifest and is young enough. Output backup_key.
cmd_backup_pick() {
  local max="$1" must="${2:-}" key stamp t age now
  need BACKUP_R2_BUCKET BACKUP_R2_ACCOUNT_ID
  key="$(list_keys backups "$BACKUP_R2_BUCKET" db/ | grep -E '^db/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z\.sql\.gz\.age$' | tail -1 || true)"
  [ -n "$key" ] || refuse "no encrypted dump under db/"
  stamp="${key#db/}"
  stamp="${stamp%.sql.gz.age}"
  t="$(date -u -d "${stamp:0:10} ${stamp:11:2}:${stamp:14:2}:${stamp:17:2}" +%s)" || refuse "the dump's time could not be read"
  now="$(date -u +%s)"
  age=$(( now - t ))
  if aws_backups s3api head-object --bucket "$BACKUP_R2_BUCKET" --key "db/$stamp.manifest.json" > /dev/null; then
    say "newest backup has a manifest: yes"
  else
    say "newest backup has a manifest: no"
    refuse "the newest dump has no manifest"
  fi
  # An evening run (from 15:00 UTC) needs an evening dump. The rehearsal's
  # second night reads the reset day's windowed job runs (03:00-15:00 UTC); a
  # dump taken earlier that day lacks the last of them, and the copy would
  # then show a gap production does not have (scheduled-jobs-on-time fails on
  # the copy, the apply is refused for nothing). The Neon rehearsal reads a
  # branch of production itself, not the dump, so it is not held to this.
  # One clock for both instants: now and the dump's time are compared with
  # 15:00 UTC of today (by the same clock as the age check).
  local cut
  cut="$(date -u -d "$(date -u -d "@$now" +%Y-%m-%d) 15:00:00" +%s)" || refuse "the clock could not be read"
  if [ "${MODE:-}" != neon-rehearsal ] && [ "$now" -ge "$cut" ]; then
    if [ "$t" -lt "$cut" ]; then
      say "newest backup taken after 15:00 UTC (19:00 Oman): no"
      refuse "the newest dump was taken before 19:00 Oman; run DB Backup again now, then start again"
    fi
    say "newest backup taken after 15:00 UTC (19:00 Oman): yes"
  fi
  if [ "$age" -le $(( max * 3600 )) ] && [ "$age" -ge -300 ]; then
    say "newest backup at most $max h old: yes"
  else
    say "newest backup at most $max h old: no"
    refuse "run DB Backup first: the newest dump is too old"
  fi
  if [ -n "$must" ]; then
    if [ "$key" = "$must" ]; then say "the rehearsed backup is still the newest: yes"; else
      say "the rehearsed backup is still the newest: no"
      refuse "a newer dump exists than the one the rehearsal restored; start again"
    fi
  fi
  set_out backup_key "$key"
  set_env CS_BACKUP_KEY "$key"
}

# backup-fetch <key>: download the dump and its manifest, record the sha256 of
# the encrypted object, decrypt to $CS_DIR/dump.sql.gz. Output backup_sha256.
cmd_backup_fetch() {
  local key="$1" sum
  [[ $key =~ ^db/[0-9T-]+Z\.sql\.gz\.age$ ]] || refuse "the dump key is not a dump key"
  aws_backups s3 cp "s3://$BACKUP_R2_BUCKET/$key" "$CS_DIR/dump.bin" > /dev/null || refuse "the dump could not be downloaded"
  aws_backups s3 cp "s3://$BACKUP_R2_BUCKET/${key%.sql.gz.age}.manifest.json" "$CS_DIR/manifest.json" > /dev/null \
    || refuse "the dump's manifest could not be downloaded"
  sum="$(sha_file "$CS_DIR/dump.bin")"
  with_identity _decrypt "$CS_DIR/dump.bin" "$CS_DIR/dump.sql.gz" || refuse "the dump could not be decrypted with BACKUP_AGE_IDENTITY"
  rm -f "$CS_DIR/dump.bin"
  gzip -t "$CS_DIR/dump.sql.gz" || refuse "the decrypted dump is not a whole gzip stream"
  say "backup decrypted: yes"
  say "backup sha256: $(short "$sum")"
  set_out backup_sha256 "$sum"
  set_env CS_BACKUP_SHA256 "$sum"
}

# encrypt-upload <prefix under cleanstart/<run>/> <file>...: age-encrypt to
# BACKUP_AGE_RECIPIENTS, upload to the backups bucket, HEAD-check each.
cmd_encrypt_upload() {
  local prefix="$1" f name ok=0
  shift
  need BACKUP_R2_BUCKET BACKUP_R2_ACCOUNT_ID
  [[ $prefix =~ ^cleanstart/[0-9]{1,20}/[a-z][a-z-]*(-[0-9]{1,20}-[0-9]{1,4})?$ ]] || refuse "the report prefix is malformed"
  age_args
  for f in "$@"; do
    [ -f "$f" ] || { ok=1; continue; }
    name="${f##*/}"
    age "${AGE_ARGS[@]}" -o "$f.age" "$f" || { ok=1; continue; }
    aws_backups s3 cp "$f.age" "s3://$BACKUP_R2_BUCKET/$prefix/$name.age" --checksum-algorithm CRC32 > /dev/null || { ok=1; continue; }
    aws_backups s3api head-object --bucket "$BACKUP_R2_BUCKET" --key "$prefix/$name.age" > /dev/null || ok=1
    rm -f "$f.age"
  done
  yes_no "encrypted copies stored (${prefix##*/})" "$ok"
  [ "$ok" -eq 0 ] || refuse "an encrypted copy could not be stored"
}

# fetch-decrypt <key under cleanstart/> <out file>: an encrypted export back.
cmd_fetch_decrypt() {
  local key="$1" out="$2"
  [[ $key =~ ^cleanstart/[0-9]{1,20}/[a-z-]+/[a-z0-9.-]+\.age$ ]] || refuse "not an encrypted clean-start export"
  aws_backups s3 cp "s3://$BACKUP_R2_BUCKET/$key" "$out.age" > /dev/null || refuse "an encrypted export could not be downloaded"
  with_identity _decrypt "$out.age" "$out" || refuse "an encrypted export could not be decrypted"
  rm -f "$out.age"
}

# dump-gates <dump.sql.gz>: db-backup.yml's own gates on a dump of the reset
# copy, and whether its size clears the floors (the first nightly backup).
cmd_dump_gates() {
  local d="$1" bytes found t ok=0 floor setto=''
  gzip -t "$d" || refuse "the dump of the reset copy is not a whole gzip stream"
  gunzip -c "$d" | awk -f "$CS_ROOT/scripts/ops/dump-rowcounts.awk" > "$CS_DIR/dump-rowcounts.tsv" 2> /dev/null \
    || refuse "the dump of the reset copy is incomplete (no completion marker or an open COPY block)"
  found=" $(cut -f1 "$CS_DIR/dump-rowcounts.tsv" | tr '\n' ' ')"
  for t in Customer Branch User AuditLog; do
    case "$found" in *" $t "*) ;; *) ok=1 ;; esac
  done
  yes_no "the nightly backup's table gate passes on the reset copy" "$ok"
  bytes="$(stat -c%s "$d")"
  for floor in 80000 40000 20000; do
    if [ "$bytes" -ge "$floor" ]; then say "dump of the reset copy at least $floor bytes: yes"; [ -n "$setto" ] || setto="$floor"
    else say "dump of the reset copy at least $floor bytes: no"; fi
  done
  if [ "$bytes" -ge 80000 ]; then
    say "first nightly backup would be below the size floor: no"
  elif [ -n "$setto" ]; then
    say "first nightly backup would be below the size floor: yes; set MIN_DUMP_BYTES to $setto"
  else
    say "first nightly backup would be below the size floor: yes; even 20000 bytes is too high, ask before the reset"
  fi
  rm -f "$CS_DIR/dump-rowcounts.tsv"
  [ "$ok" -eq 0 ] || refuse "the nightly backup's table gate would fail after the reset"
}

# watch-lines <vitest output file> <exit code>: only the status table lines of
# the watch rehearsal (rehearse-watch.ts reportLines) reach the log.
cmd_watch_lines() {
  local f="$1" rc="$2"
  grep -E '^ *(night [12]:|[a-z0-9-]+: (pass|fail|info|error)( \(not asserted\))?|MISMATCH night [12] [a-z0-9-]+: [a-z]+, expected [a-z|]+( listed)?|first integrity checks as expected: (yes|no))$' "$f" \
    | sed -e 's/^ *//' | while IFS= read -r l; do say "$l"; done || true
  if [ "$rc" -eq 0 ] && grep -q '^ *first integrity checks as expected: yes$' "$f"; then
    return 0
  fi
  say "watch rehearsal as expected: no"
  refuse "the first two nights of the integrity watch are not as expected"
}

# result <label> <exit code>: a tool's own pass/fail, its output kept in a file.
cmd_result() {
  local label="$1" rc="$2"
  yes_no "$label" "$rc"
  [ "$rc" -eq 0 ] || exit 1
}

# took <label> <start epoch seconds>
cmd_took() { say "$1 took $(( $(date -u +%s) - $2 )) s"; }

# counter <file>: the counter statement, rolled back, returned next = 2.
cmd_counter() {
  local v
  v="$(grep -E '^[0-9]+$' "$1" | head -1 || true)"
  if [ "$v" = 2 ]; then say "next customer code would be number 000001: yes"; else
    say "next customer code would be number 000001: no"
    refuse "the customer-code counter would not start at 000001"
  fi
}

# app-watch: the production watch, through the app (APPLY step h).
cmd_app_watch() {
  need PROD_CRON_SECRET APP_BASE_URL
  local code
  code="$(http "$CS_DIR/watch.json" "${APP_BASE_URL%/}/api/cron/integrity-watch" -H "Authorization: Bearer $PROD_CRON_SECRET" --max-time 300)"
  if [ "$code" = 200 ]; then say "integrity watch ran on production: yes"; else
    say "integrity watch ran on production: no"
    refuse "the integrity watch did not answer 200"
  fi
}

# compare-watch <results tsv> [foreign keys file] [may keys file]: the first
# run's statuses against expected-watch.json night 1 (compare-watch.ts prints
# the table; it explains the two key lists).
cmd_compare_watch() {
  local tsv="$1" foreign="${2:-}" may="${3:-}" rc=0
  if [ -n "$may" ] && [ -z "$foreign" ]; then foreign="$CS_DIR/no-keys.txt"; : > "$foreign"; fi
  (cd "$CS_ROOT" && node --import tsx scripts/ops/clean-start/compare-watch.ts "$tsv" ${foreign:+"$foreign"} ${may:+"$may"}) > "$CS_DIR/compare.out" 2>&1 || rc=$?
  cmd_watch_lines "$CS_DIR/compare.out" "$rc"
}

# ---------------------------------------------------------------- Neon ----

# neon-retention: Neon keeps at least 7 days of history (rollback route 1).
cmd_neon_retention() {
  local f="$CS_DIR/neon.json" code s
  code="$(neon GET "$f" '')"
  [ "$code" = 200 ] || refuse "the Neon project could not be read"
  s="$(jq -r '.project.history_retention_seconds // 0' "$f")"
  rm -f "$f"
  [[ $s =~ ^[0-9]+$ ]] || s=0
  yes_no "Neon history kept at least 7 days" "$([ "$s" -ge 604800 ]; echo $?)"
}

# neon-default: the id of the project's default branch (production).
neon_default() {
  local f="$CS_DIR/neon.json" code id
  code="$(neon GET "$f" /branches)"
  [ "$code" = 200 ] || refuse "the Neon branches could not be read"
  id="$(jq -r '.branches[]? | select(.default == true) | .id' "$f" | head -1)"
  rm -f "$f"
  [[ $id =~ ^br-[a-z0-9-]+$ ]] || refuse "the Neon default branch could not be found"
  printf '%s' "$id"
}

# neon_default_is_production <branch id>: one of that branch's endpoints has
# production's host (the first line of config/production-hosts.txt, the rule
# prod-target holds DIRECT_URL to). The default branch is only a flag in Neon:
# after a console "Set as default" (UAT lives in the same project) or with
# NEON_PROJECT_ID of another project, a copy of it would not be production.
neon_default_is_production() {
  local id="$1" f="$CS_DIR/neon.json" code host ok=1
  code="$(neon GET "$f" "/branches/$id/endpoints")"
  [ "$code" = 200 ] || { rm -f "$f"; refuse "the Neon default branch's endpoints could not be read"; }
  production_hosts_load || exit 2
  while IFS= read -r host; do
    host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
    case "$host" in "${PRODUCTION_HOSTS[0]}"*) ok=0 ;; esac
  done < <(jq -r '.endpoints[]? | .host // empty' "$f")
  rm -f "$f"
  yes_no "Neon default branch is production" "$ok"
  [ "$ok" -eq 0 ] || refuse "the Neon default branch is not production (no endpoint has the host of the first line of config/production-hosts.txt)"
}

# neon-create <name> <compute|none>: a branch of the default branch, now,
# once that branch is confirmed to be production's.
# Records its id in $CS_DIR/neon-branches BEFORE anything else can fail, so
# the always() cleanup finds it (restore-drill.yml's rule).
cmd_neon_create() {
  local name="$1" compute="$2" parent f="$CS_DIR/neon-create.json" code body id
  [[ $name =~ ^[a-z0-9-]{3,90}$ ]] || refuse "the branch name is malformed"
  parent="$(neon_default)"
  neon_default_is_production "$parent"
  if [ "$compute" = compute ]; then
    body="{\"branch\":{\"name\":\"$name\",\"parent_id\":\"$parent\"},\"endpoints\":[{\"type\":\"read_write\"}]}"
  else
    body="{\"branch\":{\"name\":\"$name\",\"parent_id\":\"$parent\"}}"
  fi
  # The NAME is recorded before the request: a timeout ("000") after Neon has
  # already made the branch still leaves the cleanup something to find (it
  # searches by name).
  printf -- '- %s\n' "$name" >> "$CS_DIR/neon-branches"
  code="$(neon POST "$f" /branches -d "$body")"
  case "$code" in 200 | 201) ;; *) refuse "Neon did not create the branch" ;; esac
  id="$(jq -r '.branch.id // empty' "$f")"
  [[ $id =~ ^br-[a-z0-9-]+$ ]] || refuse "Neon's answer has no branch id"
  [ "$id" != "$parent" ] || refuse "Neon answered with the default branch"
  jq -r '.databases[0].name // empty' "$f" > "$CS_DIR/neon-db"
  jq -r '.databases[0].owner_name // empty' "$f" > "$CS_DIR/neon-role"
  rm -f "$f"
  cmd_neon_wait "$id"
  # Confirm it exists, by name.
  f="$CS_DIR/neon.json"
  [ "$(neon GET "$f" "/branches?search=$name")" = 200 ] || refuse "the new branch could not be read back"
  [ "$(jq -r --arg n "$name" '[.branches[]? | select(.name == $n)] | length' "$f")" = 1 ] || refuse "the new branch is not there"
  rm -f "$f"
  set_env CS_NEON_BRANCH_ID "$id"
  printf '%s' "$id" > "$CS_DIR/neon-current-id"
  say "Neon branch created and confirmed: yes"
}

# The branch this job created last (the step that created it, or a later one).
# The file first: neon-create and neon-restore both write it at once, while a
# CS_NEON_BRANCH_ID written to GITHUB_ENV reaches only the LATER steps (in the
# step of neon-restore it still names the rehearsal branch).
neon_current() {
  local id
  id="$(cat "$CS_DIR/neon-current-id" 2>/dev/null || true)"
  [ -n "$id" ] || id="${CS_NEON_BRANCH_ID:-}"
  if ! [[ $id =~ ^br-[a-z0-9-]+$ ]]; then
    echo "::error::clean start refused: no Neon branch of this job is known" >&2
    exit 1
  fi
  printf '%s' "$id"
}

# neon-uri: the new branch's connection string, masked, as CS_BRANCH_URL; refused when production.
cmd_neon_uri() {
  local id db role f="$CS_DIR/neon.json" code uri st=0
  id="$(neon_current)"
  db="$(cat "$CS_DIR/neon-db" 2>/dev/null || true)"
  role="$(cat "$CS_DIR/neon-role" 2>/dev/null || true)"
  [[ $db =~ ^[A-Za-z0-9_]+$ ]] && [[ $role =~ ^[A-Za-z0-9_]+$ ]] || refuse "the branch's database or role is unknown"
  code="$(neon GET "$f" "/connection_uri?branch_id=$id&database_name=$db&role_name=$role")"
  [ "$code" = 200 ] || refuse "the branch's connection string could not be read"
  uri="$(jq -r '.uri // empty' "$f")"
  rm -f "$f"
  echo "::add-mask::$uri"
  production_hosts_load || exit 2
  production_marker_in "$uri" > /dev/null || st=$?
  [ "$st" -eq 1 ] || refuse "the Neon branch's host is a production host"
  set_env CS_BRANCH_URL "$uri"
  say "Neon branch host is not production: yes"
}

# neon_wait_status [branch id]: waits (180 s at most) until no operation is
# still running — of that branch when one is named, else of the project — and
# RETURNS 0 all finished, 1 one of that branch's failed, 2 timed out. It never
# exits: the always() cleanup must reach its final check. An old failed
# operation of another branch does not block (only the named branch's count).
neon_wait_status() {
  local b="${1:-}" i f="$CS_DIR/neon-ops.json" running failed
  for i in $(seq 1 90); do
    [ "$(neon GET "$f" '/operations?limit=20')" = 200 ] || { sleep 2; continue; }
    running="$(jq -r --arg b "$b" '[.operations[]? | select($b == "" or .branch_id == $b) | select(.status != "finished" and .status != "skipped" and .status != "cancelled" and .status != "failed")] | length' "$f")"
    failed="$(jq -r --arg b "$b" '[.operations[]? | select($b != "" and .branch_id == $b and .status == "failed")] | length' "$f")"
    if [ "$failed" != 0 ]; then rm -f "$f"; return 1; fi
    if [ "$running" = 0 ]; then rm -f "$f"; return 0; fi
    sleep 2
  done
  rm -f "$f"
  return 2
}

# neon-wait [branch id]: the same, refusing on a failure or a timeout.
cmd_neon_wait() {
  local st=0
  neon_wait_status "${1:-}" || st=$?
  case "$st" in
    0) return 0 ;;
    1) refuse "a Neon operation failed" ;;
    *) refuse "Neon operations did not finish in time" ;;
  esac
}

# neon-restore <RFC 3339 time> <name>: Neon's copy of the rehearsal branch AS
# IT WAS at that time: a NEW branch <name>, child of the rehearsal branch, made
# from its history (POST /branches with parent_timestamp), with a compute. It
# becomes the branch this job reads from the NEXT step on (CS_NEON_BRANCH_ID;
# the connection string is read again there by neon-uri).
# Not Neon's "restore" endpoint: a point-in-time restore works on ROOT branches
# only (neon.com/docs/guides/branch-restore), and the rehearsal branch is a
# child of production. Both branches are deleted by neon-cleanup (the newest
# first: Neon refuses to delete a branch that still has a child).
cmd_neon_restore() {
  local at="$1" name="$2" src def f="$CS_DIR/neon-create.json" code id
  src="$(neon_current)"
  [[ $at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || refuse "the restore time is malformed"
  [[ $name =~ ^[a-z0-9-]{3,90}$ ]] || refuse "the branch name is malformed"
  def="$(neon_default)"
  [ "$src" != "$def" ] || refuse "refusing to restore the default branch"
  # The NAME is recorded before the request (see neon-create).
  printf -- '- %s\n' "$name" >> "$CS_DIR/neon-branches"
  code="$(neon POST "$f" /branches -d "{\"branch\":{\"name\":\"$name\",\"parent_id\":\"$src\",\"parent_timestamp\":\"$at\"},\"endpoints\":[{\"type\":\"read_write\"}]}")"
  case "$code" in 200 | 201) ;; *) rm -f "$f"; refuse "Neon did not make the copy of the branch at the noted time" ;; esac
  id="$(jq -r '.branch.id // empty' "$f")"
  rm -f "$f"
  [[ $id =~ ^br-[a-z0-9-]+$ ]] || refuse "Neon's answer has no branch id"
  [ "$id" != "$src" ] && [ "$id" != "$def" ] || refuse "Neon answered with an existing branch"
  cmd_neon_wait "$id"
  f="$CS_DIR/neon.json"
  [ "$(neon GET "$f" "/branches?search=$name")" = 200 ] || refuse "the new branch could not be read back"
  [ "$(jq -r --arg n "$name" --arg p "$src" '[.branches[]? | select(.name == $n and .parent_id == $p)] | length' "$f")" = 1 ] \
    || refuse "the copy at the noted time is not there"
  rm -f "$f"
  # The same database and role as the rehearsal branch (neon-db, neon-role are kept).
  set_env CS_NEON_BRANCH_ID "$id"
  printf '%s' "$id" > "$CS_DIR/neon-current-id"
  say "Neon made a copy of the branch as it was at the noted time: yes"
}

# neon-cleanup: delete every branch this job created (the copy at the noted
# time too), never the default branch. The newest first, and repeated, since
# Neon refuses to delete a branch that still has a child.
cmd_neon_cleanup() {
  local f="$CS_DIR/neon.json" pass id name left def i names=() order=()
  [ -s "$CS_DIR/neon-branches" ] || { say "Neon branches to delete: no"; return 0; }
  while read -r id name; do names+=("$name"); done < "$CS_DIR/neon-branches"
  for ((i = ${#names[@]} - 1; i >= 0; i--)); do order+=("${names[i]}"); done
  names=("${order[@]}")
  def="$(neon_default)"
  for pass in 1 2 3; do
    left=0
    for name in "${names[@]}"; do
      [ "$(neon GET "$f" "/branches?search=$name")" = 200 ] || { left=1; continue; }
      for id in $(jq -r --arg n "$name" '.branches[]? | select(.name == $n) | .id' "$f"); do
        [ "$id" != "$def" ] || refuse "a branch to delete is the default branch"
        case "$(neon DELETE "$CS_DIR/neon-del.json" "/branches/$id")" in 200 | 202 | 204 | 404) ;; *) left=1 ;; esac
      done
    done
    # A status, never an exit: the check below must always run.
    neon_wait_status || true
    [ "$left" -eq 0 ] && break
  done
  left=0
  for name in "${names[@]}"; do
    [ "$(neon GET "$f" "/branches?search=$name")" = 200 ] || { left=1; continue; }
    [ "$(jq -r --arg n "$name" '[.branches[]? | select(.name == $n)] | length' "$f")" = 0 ] || left=1
  done
  rm -f "$f" "$CS_DIR/neon-del.json"
  yes_no "temporary Neon branches deleted" "$left"
  if [ "$left" -ne 0 ]; then
    echo "::error::a temporary Neon branch is left; delete it by hand in the Neon console (Branches): it holds a full copy of production"
    exit 1
  fi
  rm -f "$CS_DIR/neon-branches"
}

# neon-forget: the safety branch is kept (the reset committed, or may have).
cmd_neon_forget() { rm -f "$CS_DIR/neon-branches"; say "Neon safety branch kept: yes"; }

# neon-delete-safety <run id>: finish/photos: delete pre-clean-start-*-<run>.
cmd_neon_delete_safety() {
  local r f="$CS_DIR/neon.json" name
  r="$(typed_run_id "${1:-}")"
  [ "$(neon GET "$f" '/branches?search=pre-clean-start-')" = 200 ] || refuse "the Neon branches could not be read"
  : > "$CS_DIR/neon-branches"
  while IFS= read -r name; do
    [[ $name =~ ^pre-clean-start-[0-9]{4}-[0-9]{2}-[0-9]{2}-$r$ ]] && printf -- '- %s\n' "$name" >> "$CS_DIR/neon-branches"
  done < <(jq -r '.branches[]? | .name' "$f")
  rm -f "$f"
  cmd_neon_cleanup
}

# shred-dir: remove every plaintext this job wrote.
cmd_shred() {
  if [ -d "$CS_DIR" ]; then
    find "$CS_DIR" -type f -exec shred -u {} + 2>/dev/null || true
    rm -rf "$CS_DIR"
  fi
  say "plaintext work files removed: yes"
}

# ------------------------------------------------------------ dispatch ----
sub="${1:-}"
shift || true
case "$sub" in
  step) step "$@" ;;
  preflight) cmd_preflight "$@" ;;
  window) cmd_window ;;
  prod-target) cmd_prod_target "$@" ;;
  rehearse-target) cmd_rehearse_target "$@" ;;
  sql) cmd_sql "$@" ;;
  bool) cmd_bool "$@" ;;
  exports) cmd_exports "$@" ;;
  health) cmd_health ;;
  github-env) cmd_github_env ;;
  backup-idle) cmd_backup_idle ;;
  neon-green) cmd_neon_green "$@" ;;
  backup-pick) cmd_backup_pick "$@" ;;
  backup-fetch) cmd_backup_fetch "$@" ;;
  encrypt-upload) cmd_encrypt_upload "$@" ;;
  fetch-decrypt) cmd_fetch_decrypt "$@" ;;
  dump-gates) cmd_dump_gates "$@" ;;
  watch-lines) cmd_watch_lines "$@" ;;
  result) cmd_result "$@" ;;
  took) cmd_took "$@" ;;
  counter) cmd_counter "$@" ;;
  app-watch) cmd_app_watch ;;
  compare-watch) cmd_compare_watch "$@" ;;
  neon-retention) cmd_neon_retention ;;
  neon-create) cmd_neon_create "$@" ;;
  neon-uri) cmd_neon_uri ;;
  neon-wait) cmd_neon_wait "$@" ;;
  safety-cleanup) cmd_safety_cleanup ;;
  chain-id) cmd_chain_id "$@" ;;
  chain-id-fetch) cmd_chain_id_fetch "$@" ;;
  finish-may) cmd_finish_may "$@" ;;
  owner-facts) cmd_owner_facts "$@" ;;
  neon-restore) cmd_neon_restore "$@" ;;
  neon-cleanup) cmd_neon_cleanup ;;
  neon-forget) cmd_neon_forget ;;
  neon-delete-safety) cmd_neon_delete_safety "$@" ;;
  oman-date) oman_date ;;
  settle) cmd_settle "$@" ;;
  record) cmd_record "$@" ;;
  status-lines) cmd_status_lines "$@" ;;
  check-run-id) cmd_check_run_id "$@" ;;
  safety-name) cmd_safety_name ;;
  started) cmd_started ;;
  for-the-owner) cmd_for_the_owner "$@" ;;
  say-noted) say "restore point noted before the reset: yes" ;;
  shred) cmd_shred ;;
  *)
    echo "usage: run.sh <subcommand> (see the dispatch at the end of this file)" >&2
    exit 2
    ;;
esac
