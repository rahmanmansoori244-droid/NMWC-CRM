#!/usr/bin/env bash
# Go-live clean start: the OLD SEAL CHAIN's off-site copies (design sections 2,
# 5c, 5g and the rollback's seal-restore; owner question 3, recommended yes).
#
# The test period's seals have off-site copies under seals/v1/<old16>/ in the
# PHOTOS bucket (lib/seal/chain.ts sealObjectKey). After the reset the chain
# starts again from a new genesis, so the old copies would read as "another
# chain" every night and scripts/ops/verify-seals.ts would fail for good. So
# they are first copied to the BACKUPS bucket (which the app's token cannot
# write), each copy read back and hash-checked, and only then removed from the
# live folder.
#
#   bash scripts/ops/clean-start/seal-archive.sh verify  <seals.jsonl> <old16|none>
#   bash scripts/ops/clean-start/seal-archive.sh archive <seals.jsonl> <old16|none> <run id>
#   bash scripts/ops/clean-start/seal-archive.sh retire  <seals.jsonl> <old16|none> <run id>
#   bash scripts/ops/clean-start/seal-archive.sh restore <seals.jsonl> <old16|none> <run id> <new16>
#
# seals.jsonl is the PLAN export (one SealRecord per line: seq, day, hash,
# r2Key, bodyText), bound to the plan id. Every seal's hash is the SHA-256 of
# its body (the sealrecord link guard), which is what each copy is checked
# against; the chain is checked by the bodies' "prev" fields.
#
#   verify   read-only (the read-only photo token): lists seals/, splits it into
#            the old chain's own seal keys and everything else ("foreign":
#            another environment's chain folder, a non-seal object), downloads
#            every old copy and compares its sha256 with the seal's hash. A copy
#            that DIFFERS refuses; a MISSING copy is allowed (archive then uses
#            the body from the export). Writes $CS_DIR/seal-keys-foreign.txt and
#            $CS_DIR/seal-keys-own.txt.
#   archive  APPLY step c, additive only: every old seal (the R2 copy, or the
#            exported body where none) to
#            <backups>/cleanstart/<run>/seal-archive/seals/v1/<old16>/<seq>.json,
#            each re-read: sha256 = hash, seqs 0..n with no gap, prev links
#            chain. An archive object already there with other bytes refuses.
#   retire   APPLY step g: deletes from seals/v1/<old16>/ only keys that the
#            listing named AND whose archive copy re-reads with the right hash
#            (read-write photo token). Never a foreign key. HEAD-checks each.
#   restore  mode seal-restore, after the database was put back: copies every
#            archived seal back to its live key (hash-checked; an existing live
#            copy with other bytes refuses), then moves the NEW chain's objects
#            (only seals/v1/<new16>/, the id the apply or finish run recorded;
#            every other object under seals/ is left alone, since the bucket is
#            shared with other environments) to
#            <backups>/cleanstart/<run>/abandoned-chain/, checked byte for byte
#            before each live copy is deleted.
#
# "Gone" is decided only by a definite not-found answer of the store; any other
# failed HEAD (403, network, throttling) counts as "still there".
#
# It opens no database. It prints only yes/no lines (run.sh say); keys and
# counts go to $CS_DIR/seal-archive.report (encrypted with the run's report).
# Exit 0 = done; 1 = refused (one line says why).
set -euo pipefail
umask 077
case "${BASH_SOURCE[0]}" in */*) SA_HERE="${BASH_SOURCE[0]%/*}" ;; *) SA_HERE=. ;; esac

CS_DIR="${CS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/clean-start}"
mkdir -p "$CS_DIR"
REPORT="$CS_DIR/seal-archive.report"

say() {
  printf '%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- %s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}
yes_no() { if [ "$2" -eq 0 ]; then say "$1: yes"; else say "$1: no"; fi; }
refuse() {
  echo "::error::seal archive refused: $1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- **refused: %s**\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 1
}
note() { printf '%s\n' "$*" >> "$REPORT"; }
sha_file() { sha256sum < "$1" | cut -d' ' -f1; }

photos_endpoint() { printf 'https://%s.r2.cloudflarestorage.com' "${PHOTOS_R2_ACCOUNT_ID:?}"; }
backups_endpoint() { printf 'https://%s.r2.cloudflarestorage.com' "${BACKUP_R2_ACCOUNT_ID:?}"; }
aws_ro() {
  AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RO_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RO_SECRET_ACCESS_KEY:?}" \
    aws "$@" --endpoint-url "$(photos_endpoint)" 2>> "$CS_DIR/aws.log"
}
aws_rw() {
  AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RW_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RW_SECRET_ACCESS_KEY:?}" \
    aws "$@" --endpoint-url "$(photos_endpoint)" 2>> "$CS_DIR/aws.log"
}
aws_bk() {
  AWS_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY:?}" \
    aws "$@" --endpoint-url "$(backups_endpoint)" 2>> "$CS_DIR/aws.log"
}
list_keys() {
  local who="$1" bucket="$2" prefix="$3" raw
  raw="$("aws_$who" s3api list-objects-v2 --bucket "$bucket" --prefix "$prefix" --query 'Contents[].Key' --output text)" || return 1
  printf '%s\n' "$raw" | tr '\t' '\n' | grep -v -x -e '' -e 'None' | LC_ALL=C sort || true
}
# get <ro|rw|bk> <bucket> <key> <file>: 0 = downloaded, 1 = not there / unreadable.
get() { "aws_$1" s3 cp "s3://$2/$3" "$4" > /dev/null; }
# present <ro|rw|bk> <bucket> <key>: 0 = the object is there, 1 = it is NOT
# (the store answered 404 / NoSuchKey / Not Found), 2 = unknown (403, a network
# error, throttling...). Only a definite "not found" counts as gone: an unknown
# answer is never taken as "deleted".
present() {
  local err="$CS_DIR/head.err" rc=0
  : > "$err"
  case "$1" in
    ro) AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RO_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RO_SECRET_ACCESS_KEY:?}" \
          aws s3api head-object --bucket "$2" --key "$3" --endpoint-url "$(photos_endpoint)" > /dev/null 2> "$err" || rc=$? ;;
    rw) AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RW_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RW_SECRET_ACCESS_KEY:?}" \
          aws s3api head-object --bucket "$2" --key "$3" --endpoint-url "$(photos_endpoint)" > /dev/null 2> "$err" || rc=$? ;;
    bk) AWS_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY:?}" \
          aws s3api head-object --bucket "$2" --key "$3" --endpoint-url "$(backups_endpoint)" > /dev/null 2> "$err" || rc=$? ;;
  esac
  cat "$err" >> "$CS_DIR/aws.log" 2>/dev/null || true
  if [ "$rc" -eq 0 ]; then rm -f "$err"; return 0; fi
  if grep -qE '\((404|NoSuchKey|NotFound)\)|Not Found' "$err"; then rm -f "$err"; return 1; fi
  rm -f "$err"
  return 2
}
# gone <who> <bucket> <key>: 0 only when the store says the object is not there.
gone() { local s=0; present "$@" || s=$?; [ "$s" -eq 1 ]; }

mode="${1:-}"
seals="${2:-}"
old="${3:-}"
run="${4:-}"
case "$mode" in verify | archive | retire | restore) ;; *)
  echo "usage: seal-archive.sh verify|archive|retire|restore <seals.jsonl> <old16|none> [run id] [new16]" >&2
  exit 2 ;;
esac
[ -f "$seals" ] || refuse "the seal export is missing"
[[ $old =~ ^([0-9a-f]{16}|none)$ ]] || refuse "the old chain id is malformed"
if [ "$mode" != verify ]; then [[ $run =~ ^[0-9]{1,20}$ ]] || refuse "the run id is malformed"; fi
PHOTOS="${PHOTOS_BUCKET:?}"
ARCHIVE_PREFIX="cleanstart/$run/seal-archive/"

# The export, parsed once: "seq hash key" lines, and each body in its own file
# (bytes exactly as hashed: jq -j writes no newline).
WORK="$CS_DIR/seals"
rm -rf "$WORK"
mkdir -p "$WORK"
: > "$WORK/index"
n=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  printf '%s' "$line" > "$WORK/line"
  seq="$(jq -r '.seq' "$WORK/line")"
  hash="$(jq -r '.hash' "$WORK/line")"
  key="$(jq -r '.r2Key' "$WORK/line")"
  [[ $seq =~ ^[0-9]{1,8}$ ]] && [[ $hash =~ ^[0-9a-f]{64}$ ]] || refuse "a seal in the export is malformed"
  [ "$seq" -eq "$n" ] || refuse "the exported seals do not run from 0 without a gap"
  want="seals/v1/$old/$(printf '%08d' "$seq").json"
  [ "$old" != none ] || refuse "seals exist but the old chain id is none"
  [ "$key" = "$want" ] || refuse "a seal's stored key is not its chain key"
  jq -j '.bodyText' "$WORK/line" > "$WORK/$seq.body"
  [ "$(sha_file "$WORK/$seq.body")" = "$hash" ] || refuse "an exported seal body does not hash to its seal"
  printf '%s %s %s\n' "$seq" "$hash" "$key" >> "$WORK/index"
  n=$((n + 1))
done < "$seals"
rm -f "$WORK/line"
note "mode=$mode seals=$n old_chain=$old"

# chain_ok <dir with <seq>.json>: prev links run from null through every hash.
chain_ok() {
  local dir="$1" prev=null s h k p
  while read -r s h k; do
    p="$(jq -r '.prev // "null"' "$dir/$s.json")"
    [ "$p" = "$prev" ] || return 1
    prev="$h"
  done < "$WORK/index"
}

case "$mode" in
verify)
  list_keys ro "$PHOTOS" seals/ > "$CS_DIR/seal-keys-all.txt" || refuse "seals/ could not be listed"
  cut -d' ' -f3 "$WORK/index" | LC_ALL=C sort > "$CS_DIR/seal-keys-expected.txt"
  LC_ALL=C comm -12 "$CS_DIR/seal-keys-all.txt" "$CS_DIR/seal-keys-expected.txt" > "$CS_DIR/seal-keys-own.txt"
  LC_ALL=C comm -23 "$CS_DIR/seal-keys-all.txt" "$CS_DIR/seal-keys-expected.txt" > "$CS_DIR/seal-keys-foreign.txt"
  missing=0
  differs=0
  while read -r s h k; do
    if grep -qxF "$k" "$CS_DIR/seal-keys-own.txt"; then
      get ro "$PHOTOS" "$k" "$WORK/copy" || { differs=1; note "unreadable $k"; continue; }
      if [ "$(sha_file "$WORK/copy")" != "$h" ]; then differs=1; note "differs $k"; fi
      rm -f "$WORK/copy"
    else
      missing=1
      note "missing $k"
    fi
  done < "$WORK/index"
  note "foreign: $(wc -l < "$CS_DIR/seal-keys-foreign.txt")"
  yes_no "old seal chain present" "$([ "$n" -gt 0 ]; echo $?)"
  yes_no "every old seal copy that exists matches its seal" "$differs"
  yes_no "an old seal copy is missing (its body is archived from the export)" "$([ "$missing" -eq 1 ]; echo $?)"
  yes_no "other objects under seals/ (reported once on the first night)" "$([ -s "$CS_DIR/seal-keys-foreign.txt" ]; echo $?)"
  [ "$differs" -eq 0 ] || refuse "an old seal copy differs from its seal"
  ;;

archive)
  if [ "$n" -eq 0 ]; then say "old seals to archive: no"; exit 0; fi
  : "${BACKUP_R2_BUCKET:?}"
  [ -s "$CS_DIR/seal-keys-own.txt" ] || [ -f "$CS_DIR/seal-keys-own.txt" ] || refuse "run verify first"
  mkdir -p "$WORK/back"
  while read -r s h k; do
    src="$WORK/$s.body"
    if grep -qxF "$k" "$CS_DIR/seal-keys-own.txt" && get ro "$PHOTOS" "$k" "$WORK/copy" && [ "$(sha_file "$WORK/copy")" = "$h" ]; then
      src="$WORK/copy"
    fi
    dest="$ARCHIVE_PREFIX$k"
    st=0
    present bk "$BACKUP_R2_BUCKET" "$dest" || st=$?
    if [ "$st" -eq 0 ]; then
      get bk "$BACKUP_R2_BUCKET" "$dest" "$WORK/back/$s.json" || refuse "an archive copy could not be read"
      [ "$(sha_file "$WORK/back/$s.json")" = "$h" ] || refuse "an archive copy already there has other bytes"
    elif [ "$st" -eq 1 ]; then
      aws_bk s3 cp "$src" "s3://$BACKUP_R2_BUCKET/$dest" --content-type application/json \
        --metadata "nmwc-seal-hash=$h" --checksum-algorithm CRC32 > /dev/null || refuse "an old seal could not be archived"
    else
      refuse "the backups bucket did not say whether an archive copy is there"
    fi
    rm -f "$WORK/copy"
  done < "$WORK/index"
  # Re-read every archive copy from the bucket, then check the chain.
  ok=0
  while read -r s h k; do
    get bk "$BACKUP_R2_BUCKET" "$ARCHIVE_PREFIX$k" "$WORK/back/$s.json" || { ok=1; continue; }
    [ "$(sha_file "$WORK/back/$s.json")" = "$h" ] || ok=1
  done < "$WORK/index"
  [ "$ok" -eq 0 ] && chain_ok "$WORK/back" || ok=1
  note "archived=$n prefix=$ARCHIVE_PREFIX"
  yes_no "old seals archived, re-read and chained" "$ok"
  [ "$ok" -eq 0 ] || refuse "the seal archive does not re-read as the old chain"
  ;;

retire)
  if [ "$n" -eq 0 ]; then say "old seal files to remove: no"; exit 0; fi
  : "${BACKUP_R2_BUCKET:?}"
  [ -f "$CS_DIR/seal-keys-own.txt" ] || refuse "run verify first"
  ok=0
  removed=0
  while read -r s h k; do
    # Listed at verify AND still there now; otherwise nothing to remove.
    grep -qxF "$k" "$CS_DIR/seal-keys-own.txt" || continue
    get bk "$BACKUP_R2_BUCKET" "$ARCHIVE_PREFIX$k" "$WORK/arch" || { ok=1; note "no archive $k"; continue; }
    if [ "$(sha_file "$WORK/arch")" != "$h" ]; then ok=1; note "archive differs $k"; continue; fi
    rm -f "$WORK/arch"
    # Deleted unless the store says it is already gone (an unknown answer deletes too: harmless).
    if ! gone ro "$PHOTOS" "$k"; then
      aws_rw s3api delete-object --bucket "$PHOTOS" --key "$k" > /dev/null || { ok=1; continue; }
    fi
    # Counted as removed only on a definite "not found".
    if gone ro "$PHOTOS" "$k"; then removed=$((removed + 1)); else ok=1; note "still there or unknown $k"; fi
  done < "$WORK/index"
  note "retired=$removed"
  yes_no "old seal files removed from the live folder, each with a verified archive copy" "$ok"
  [ "$ok" -eq 0 ] || refuse "an old seal file was not removed (it stays; nothing without an archive copy is touched)"
  ;;

restore)
  # The NEW chain is named, never inferred: production's new chain id (the
  # first 16 hex of the post-reset seq-0 seal's hash), recorded encrypted by
  # the apply or finish run. The photo bucket is shared with other
  # environments, whose own chains keep growing under seals/v1/<their id>/:
  # anything outside seals/v1/<new>/ is left exactly where it is.
  new="${5:-}"
  [[ $new =~ ^[0-9a-f]{16}$ ]] || refuse "the new seal chain's id is missing or malformed"
  [ "$new" != "$old" ] || refuse "the new seal chain's id is the old chain's"
  : "${BACKUP_R2_BUCKET:?}"
  ok=0
  while read -r s h k; do
    get bk "$BACKUP_R2_BUCKET" "$ARCHIVE_PREFIX$k" "$WORK/arch" || { ok=1; note "no archive $k"; continue; }
    [ "$(sha_file "$WORK/arch")" = "$h" ] || { ok=1; note "archive differs $k"; continue; }
    st=0
    present ro "$PHOTOS" "$k" || st=$?
    if [ "$st" -eq 0 ]; then
      get ro "$PHOTOS" "$k" "$WORK/live" || { ok=1; continue; }
      [ "$(sha_file "$WORK/live")" = "$h" ] || { ok=1; note "live differs $k"; }
      continue
    elif [ "$st" -ne 1 ]; then
      ok=1; note "unknown whether live $k"; continue
    fi
    aws_rw s3 cp "$WORK/arch" "s3://$PHOTOS/$k" --content-type application/json \
      --metadata "nmwc-seal-hash=$h" > /dev/null || { ok=1; continue; }
    get ro "$PHOTOS" "$k" "$WORK/live" && [ "$(sha_file "$WORK/live")" = "$h" ] || { ok=1; note "not restored $k"; }
  done < "$WORK/index"
  yes_no "old seal files back in the live folder, hash-checked" "$ok"
  [ "$ok" -eq 0 ] || refuse "an old seal file could not be put back"
  # The new chain: exactly the seal keys under seals/v1/<new>/.
  list_keys ro "$PHOTOS" seals/ > "$CS_DIR/seal-keys-now.txt" || refuse "seals/ could not be listed"
  grep -F "seals/v1/$new/" "$CS_DIR/seal-keys-now.txt" > "$CS_DIR/seal-keys-new.txt" || true
  others="$(grep -v -F -e "seals/v1/$new/" -e "seals/v1/$old/" "$CS_DIR/seal-keys-now.txt" | grep -c . || true)"
  note "left_alone=$others"
  moved=0
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    [[ $k =~ ^seals/v1/$new/[0-9]{8}\.json$ ]] || { ok=1; note "not a seal key, left $k"; continue; }
    get ro "$PHOTOS" "$k" "$WORK/new" || { ok=1; continue; }
    dest="cleanstart/$run/abandoned-chain/$k"
    aws_bk s3 cp "$WORK/new" "s3://$BACKUP_R2_BUCKET/$dest" --content-type application/json > /dev/null || { ok=1; continue; }
    get bk "$BACKUP_R2_BUCKET" "$dest" "$WORK/moved" && [ "$(sha_file "$WORK/moved")" = "$(sha_file "$WORK/new")" ] \
      || { ok=1; note "move not verified $k"; continue; }
    aws_rw s3api delete-object --bucket "$PHOTOS" --key "$k" > /dev/null || { ok=1; continue; }
    if gone ro "$PHOTOS" "$k"; then moved=$((moved + 1)); else ok=1; note "still there or unknown $k"; fi
  done < "$CS_DIR/seal-keys-new.txt"
  note "restored=$n abandoned_moved=$moved"
  yes_no "other objects under seals/ left where they are" "$([ "${others:-0}" -gt 0 ]; echo $?)"
  yes_no "the abandoned new chain moved out of the live folder" "$ok"
  [ "$ok" -eq 0 ] || refuse "the abandoned chain could not be moved completely"
  ;;
esac
