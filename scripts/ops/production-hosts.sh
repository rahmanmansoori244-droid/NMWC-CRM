# shellcheck shell=bash
# The production host list for shell steps — the twin of scripts/lib/production-hosts.cjs,
# reading the same file, config/production-hosts.txt, by the same rules (code review
# 2026-11-10, finding 14). Sourced by scripts/ops/restore-load.sh and the DB Backup
# and Restore drill workflows:
#
#   . scripts/ops/production-hosts.sh
#   production_hosts_load || exit 1           # PRODUCTION_HOSTS=(…), first = production now
#   if marker="$(production_marker_in "$URL")"; then …the URL is production…; fi
#   host="$(pg_url_host "$URL")"
#
# FAIL-CLOSED, as in Node: a missing file, an empty list or a malformed line makes
# production_hosts_load print why and return 1, and production_marker_in return 2
# (never "not production") until a list has been loaded. Nothing here prints a URL.
# tests/unit/production-hosts.test.ts runs both readers on the same lists.

PRODUCTION_HOSTS=()
PRODUCTION_HOSTS_LOADED=''

_production_hosts_file() {
  local dir
  case "${BASH_SOURCE[0]}" in */*) dir="${BASH_SOURCE[0]%/*}" ;; *) dir=. ;; esac
  printf '%s' "$dir/../../config/production-hosts.txt"
}

# production_hosts_load [file] — reads the list into PRODUCTION_HOSTS. Returns 1 (and
# says why, as a GitHub error line) when it cannot be read, is empty or has a bad line.
production_hosts_load() {
  local file="${1:-$(_production_hosts_file)}" line n=0 marker
  PRODUCTION_HOSTS=()
  PRODUCTION_HOSTS_LOADED=''
  if [ ! -r "$file" ]; then
    echo "::error::[production-hosts] refusing: config/production-hosts.txt could not be read. The guards cannot tell which database is production, so nothing runs until it is fixed (docs/OPERATIONS.md, Runbook A)." >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%%#*}"
    # Trimmed, not squeezed: a space inside a line makes it malformed, as in Node.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$line" ]; then continue; fi
    if ! [[ $line =~ ^[a-z0-9][a-z0-9.-]{5,62}$ ]]; then
      # The line number only: a malformed line may be a pasted connection string.
      echo "::error::[production-hosts] refusing: line ${n} of config/production-hosts.txt is not a host marker. Nothing runs until it is fixed (docs/OPERATIONS.md, Runbook A)." >&2
      PRODUCTION_HOSTS=()
      return 1
    fi
    for marker in "${PRODUCTION_HOSTS[@]}"; do
      if [ "$marker" = "$line" ]; then continue 2; fi
    done
    PRODUCTION_HOSTS+=("$line")
  done < "$file"
  if [ "${#PRODUCTION_HOSTS[@]}" -eq 0 ]; then
    echo "::error::[production-hosts] refusing: config/production-hosts.txt lists no host. Nothing runs until it is fixed (docs/OPERATIONS.md, Runbook A)." >&2
    return 1
  fi
  PRODUCTION_HOSTS_LOADED=1
}

# One %XX at a time, as libpq decodes: only a well-formed escape is decoded, and
# nothing else is read as an escape (printf %b would also act on a `\c` and stop early).
percent_decoded() {
  local rest="$1" out='' ch
  while [[ $rest =~ %([0-9A-Fa-f]{2}) ]]; do
    out+="${rest%%"${BASH_REMATCH[0]}"*}"
    printf -v ch "\\x${BASH_REMATCH[1]}"
    out+="$ch"
    rest="${rest#*"${BASH_REMATCH[0]}"}"
  done
  printf '%s' "$out$rest"
}

# production_marker_in <value> — prints the first listed marker found ANYWHERE in the
# value (any case, as written or percent-decoded) and returns 0; returns 1 when none;
# returns 2 when no valid list is loaded (the caller must treat that as a refusal).
production_marker_in() {
  if [ -z "$PRODUCTION_HOSTS_LOADED" ] || [ "${#PRODUCTION_HOSTS[@]}" -eq 0 ]; then return 2; fi
  local raw decoded marker
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  decoded="$(percent_decoded "$1" | tr '[:upper:]' '[:lower:]')"
  for marker in "${PRODUCTION_HOSTS[@]}"; do
    case "$raw" in *"$marker"*) printf '%s' "$marker"; return 0 ;; esac
    case "$decoded" in *"$marker"*) printf '%s' "$marker"; return 0 ;; esac
  done
  return 1
}

# pg_url_host <postgresql URL> — the host between the last `@` of the authority and
# the port, path or query, lower-cased; empty when there is none.
pg_url_host() {
  local rest="${1#*://}" authority hostport
  authority="${rest%%[/?]*}"
  hostport="${authority##*@}"
  printf '%s' "${hostport%%:*}" | tr '[:upper:]' '[:lower:]'
}
