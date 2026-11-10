#!/usr/bin/env bash
# Go-live clean start: WHICH DATABASE may reset.sql run on? (design build_plan 3,
# "host guards"). Run it immediately before the command that runs reset.sql.
# It connects to nothing: it only reads the connection string it is given.
#
#   bash scripts/ops/clean-start/target-guard.sh apply      # production, the owner's yes
#   bash scripts/ops/clean-start/target-guard.sh rehearse   # anything that is NOT production
#
# It reads, from the environment (never from arguments, so no connection string
# reaches a process list or a log):
#   DIRECT_URL           the connection string reset.sql will be run on
#   CONFIRM_HOST         apply only: what the owner typed in confirm_host
#   CONFIRM_PHRASE       apply only: what the owner typed in confirm_phrase
#   PROD_DB_HOST_MARKER  apply only, optional: the repository variable; when set
#                        it must name the same production marker
#
# Production is recognised ONLY through the shared host list
# (config/production-hosts.txt, read by scripts/ops/production-hosts.sh); no
# host is written in this file.
#
#   apply     the connection string's HOST must start with a production marker
#             of the list, CONFIRM_HOST must name that marker (its first part,
#             as typed: "ep-sweet-haze"), PROD_DB_HOST_MARKER (if set) the same,
#             and CONFIRM_PHRASE must be exactly
#             "REMOVE ALL TEST DATA <today's date in Oman, YYYY-MM-DD>".
#   rehearse  the connection string must carry NO production marker anywhere
#             (restore-load.sh's rule): the restored backup in the runner, a
#             Neon branch, a CI database.
#
# Exit 0 = this target is allowed for this mode; 1 = refused (one line on
# stderr says why, never the URL); 2 = usage, or the host list is unreadable.
set -u

here="${BASH_SOURCE[0]%/*}"
[ "$here" = "${BASH_SOURCE[0]}" ] && here=.
# shellcheck source=../production-hosts.sh
. "$here/../production-hosts.sh"

refuse() {
  echo "clean-start target guard: refused: $1" >&2
  exit 1
}

mode="${1:-}"
case "$mode" in
  apply | rehearse) ;;
  *)
    echo "usage: target-guard.sh apply|rehearse  (DIRECT_URL, CONFIRM_HOST, CONFIRM_PHRASE from the environment)" >&2
    exit 2
    ;;
esac

if ! production_hosts_load; then
  exit 2
fi

url="${DIRECT_URL:-}"
[ -n "$url" ] || refuse "DIRECT_URL is not set"

host="$(pg_url_host "$url")"
[ -n "$host" ] || refuse "the connection string has no host this guard can read"

marker_anywhere=''
marker_anywhere="$(production_marker_in "$url")"
anywhere_rc=$?
if [ "$anywhere_rc" -eq 2 ]; then
  exit 2
fi

if [ "$mode" = rehearse ]; then
  if [ "$anywhere_rc" -eq 0 ]; then
    refuse "this connection points at PRODUCTION (${marker_anywhere}...); a rehearsal never runs there"
  fi
  echo "clean-start target guard: rehearsal target is not production: yes"
  exit 0
fi

# apply: the host itself must be production's, named by the owner.
host_marker=''
for m in "${PRODUCTION_HOSTS[@]}"; do
  case "$host" in "$m"*) host_marker="$m"; break ;; esac
done
[ -n "$host_marker" ] || refuse "apply runs only on production, and this host is not on the production host list"

typed="$(printf '%s' "${CONFIRM_HOST:-}" | tr '[:upper:]' '[:lower:]')"
[ -n "$typed" ] || refuse "confirm_host is empty"
[ "$typed" = "$host_marker" ] || refuse "confirm_host does not name the production host this connection points at"

if [ -n "${PROD_DB_HOST_MARKER:-}" ]; then
  pinned="$(printf '%s' "$PROD_DB_HOST_MARKER" | tr '[:upper:]' '[:lower:]')"
  [ "$pinned" = "$host_marker" ] || refuse "PROD_DB_HOST_MARKER names another host than this connection"
fi

# Oman is UTC+4 all year (no daylight saving): computed from UTC, so a runner
# without the zone database cannot silently give the UTC date.
oman_today="$(date -u -d "@$(( $(date -u +%s) + 4 * 3600 ))" +%Y-%m-%d)"
[ "${CONFIRM_PHRASE:-}" = "REMOVE ALL TEST DATA ${oman_today}" ] || refuse "confirm_phrase is not exactly REMOVE ALL TEST DATA followed by today's date in Oman"

echo "clean-start target guard: production named by the owner and the phrase typed: yes"
exit 0
