#!/usr/bin/env bash
# Go-live clean start: delete the TEST PHOTOS (design section 6; owner
# questions 7-10, recommended defaults). Run only by
# .github/workflows/clean-start-photos.yml, at least 7 days after the reset,
# after the owner's approval. IT CANNOT BE UNDONE.
#
#   bash scripts/ops/clean-start/photo-delete.sh check  <list> <reset row file> <production keys file> [UAT keys file]
#   bash scripts/ops/clean-start/photo-delete.sh delete <list> [UAT keys file]
#
#   list               photo-keys.txt from the reset run's encrypted export:
#                      every Attachment.r2Key production held at the plan
#   reset row file     "<epoch seconds of the reset row> <its photoKeysSha256>",
#                      read from production's AuditLog row cleanstart-<run>
#   production keys    every Attachment.r2Key production holds NOW
#   UAT keys           every Attachment.r2Key the test environment holds
#                      (optional: only when the read-only UAT secret is set)
#   LIST_SHA256        (environment) the value the owner typed
#
# check refuses unless ALL hold:
#   - the reset row exists and is at least 7 days old;
#   - sha256(list) = the typed value = the value in the reset row;
#   - no production Attachment row references a listed key. One hit means
#     production was rolled back to before the reset, so EVERYTHING is refused.
# delete then:
#   - skips every key that fails the photo pattern (app/api/photos/presign);
#   - skips every key the UAT stand-in references;
#   - deletes the rest with DeleteObjects in batches of at most 1000 (PHOTO_DELETE_BATCH
#     may only make a batch SMALLER, for the tests; the
#     read-write photo token), and HEAD-checks each one is gone.
# Nothing is listed by prefix; an upload no record points to is never touched.
# It opens no database (the workflow writes the key files). It prints yes/no
# lines only; counts go to $CS_DIR/photo-delete.report (encrypted with the run's
# report). Exit 0 = done; 1 = refused or not every key is gone.
set -euo pipefail
umask 077

PHOTO_KEY_RE='^[0-9]{4}/[0-9]{2}/[0-9]{2}/[A-Za-z0-9]+/[A-Z_]+/[0-9a-f-]{36}\.(jpg|png|webp)$'
MIN_AGE_SECONDS=$((7 * 86400))

say() {
  printf '%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- %s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}
yes_no() { if [ "$2" -eq 0 ]; then say "$1: yes"; else say "$1: no"; fi; }
refuse() {
  echo "::error::photo deletion refused: $1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- **refused: %s**\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 1
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
REPORT="$CS_DIR/photo-delete.report"
note() { printf '%s\n' "$*" >> "$REPORT"; }
sha_file() { sha256sum < "$1" | cut -d' ' -f1; }
aws_rw() {
  AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RW_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RW_SECRET_ACCESS_KEY:?}" \
    aws "$@" --endpoint-url "https://${PHOTOS_R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com" 2>> "$CS_DIR/aws.log"
}
sorted() { tr -d '\r' < "$1" | grep -v '^$' | LC_ALL=C sort -u || true; }

# head_rw <key>: 0 = there, 1 = definitely not found, 2 = unknown (the read-write token).
head_rw() {
  local rc=0
  AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RW_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RW_SECRET_ACCESS_KEY:?}" \
    aws s3api head-object --bucket "$PHOTOS_BUCKET" --key "$1" --endpoint-url "https://${PHOTOS_R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com" \
    > /dev/null 2> "$CS_DIR/pd-head.err" || rc=$?
  cat "$CS_DIR/pd-head.err" >> "$CS_DIR/aws.log" 2>/dev/null || true
  if [ "$rc" -eq 0 ]; then rm -f "$CS_DIR/pd-head.err"; return 0; fi
  if grep -qE '\((404|NoSuchKey|NotFound)\)|Not Found' "$CS_DIR/pd-head.err"; then rm -f "$CS_DIR/pd-head.err"; return 1; fi
  rm -f "$CS_DIR/pd-head.err"
  return 2
}

mode="${1:-}"
list="${2:-}"
case "$mode" in check | delete | probe) ;; *)
  echo "usage: photo-delete.sh check <list> <reset row> <production keys> [uat keys] | delete <list> [uat keys] | probe <run id>" >&2
  exit 2 ;;
esac

# probe <run id>: BEFORE anything is deleted (the Neon safety branch included),
# the read-write photo token writes a throwaway object, reads it back and deletes
# it, and the store then says it is gone. A swapped (read-only), expired or
# revoked token, or a wrong bucket name, is refused here, not after the
# irreversible steps. (A HEAD has no body: a missing bucket answers it as a
# missing key does, so "gone" alone could never prove the bucket.)
if [ "$mode" = probe ]; then
  [[ $list =~ ^[0-9]{1,20}$ ]] || refuse "the run id is malformed"
  : "${PHOTOS_BUCKET:?}"
  pk="cleanstart-probe/$list-$(date -u +%s).txt"
  printf 'clean-start photo step: a write-and-delete check of the read-write token\n' > "$CS_DIR/pd-probe.txt"
  ok=1
  st=9
  if aws_rw s3 cp "$CS_DIR/pd-probe.txt" "s3://$PHOTOS_BUCKET/$pk" --content-type text/plain > /dev/null; then
    st=0
    head_rw "$pk" || st=$?
    if [ "$st" -eq 0 ] && aws_rw s3api delete-object --bucket "$PHOTOS_BUCKET" --key "$pk" > /dev/null; then
      st=0
      head_rw "$pk" || st=$?
      [ "$st" -eq 1 ] && ok=0
    fi
  fi
  rm -f "$CS_DIR/pd-probe.txt"
  note "probe=$pk ok=$ok"
  yes_no "the read-write photo token can write and delete in the photo bucket" "$ok"
  [ "$ok" -eq 0 ] || refuse "the read-write photo token cannot write and delete in the photo bucket (a wrong, read-only or expired token, or a wrong bucket name); nothing was deleted"
  exit 0
fi

[ -f "$list" ] || refuse "the stored key list is missing"

if [ "$mode" = check ]; then
  row="${3:-}"
  prod="${4:-}"
  [ -f "$row" ] && [ -f "$prod" ] || refuse "the reset row or production's key list is missing"
  read -r at rowsum _rest < <(tr -d '\r' < "$row") || true
  [[ ${at:-} =~ ^[0-9]{9,11}$ ]] || refuse "the reset row of this run is not in production"
  age=$(( $(date -u +%s) - at ))
  yes_no "the reset is at least 7 days old" "$([ "$age" -ge "$MIN_AGE_SECONDS" ]; echo $?)"
  [ "$age" -ge "$MIN_AGE_SECONDS" ] || refuse "the reset is less than 7 days old"
  sum="$(sha_file "$list")"
  [[ ${LIST_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || refuse "list_sha256 is not a sha256"
  same=1
  [ "$sum" = "$LIST_SHA256" ] && [ "$sum" = "${rowsum:-}" ] && same=0
  yes_no "the stored list, the typed value and the reset row agree" "$same"
  [ "$same" -eq 0 ] || refuse "the list's sha256 is not the typed value and the reset row's value"
  sorted "$list" > "$CS_DIR/pd-list"
  sorted "$prod" > "$CS_DIR/pd-prod"
  hits="$(LC_ALL=C comm -12 "$CS_DIR/pd-list" "$CS_DIR/pd-prod" | wc -l | tr -d ' ')"
  note "production_references=$hits"
  yes_no "production references none of the listed photos" "$([ "$hits" = 0 ]; echo $?)"
  [ "$hits" = 0 ] || refuse "production still references a listed photo: it was rolled back, so nothing is deleted"
  exit 0
fi

# delete
uat="${3:-}"
sorted "$list" > "$CS_DIR/pd-list"
grep -E "$PHOTO_KEY_RE" "$CS_DIR/pd-list" > "$CS_DIR/pd-shaped" || true
skipped_shape=$(( $(wc -l < "$CS_DIR/pd-list") - $(wc -l < "$CS_DIR/pd-shaped") ))
if [ -n "$uat" ]; then
  [ -f "$uat" ] || refuse "the test environment's key list is missing"
  sorted "$uat" > "$CS_DIR/pd-uat"
  LC_ALL=C comm -23 "$CS_DIR/pd-shaped" "$CS_DIR/pd-uat" > "$CS_DIR/pd-go"
  say "test environment checked for shared photos: yes"
else
  cp "$CS_DIR/pd-shaped" "$CS_DIR/pd-go"
  say "test environment checked for shared photos: no (no read-only UAT connection set)"
fi
skipped_uat=$(( $(wc -l < "$CS_DIR/pd-shaped") - $(wc -l < "$CS_DIR/pd-go") ))
yes_no "keys skipped because they do not have the photo shape" "$([ "$skipped_shape" -gt 0 ]; echo $?)"
yes_no "keys kept because the test environment uses them" "$([ "$skipped_uat" -gt 0 ]; echo $?)"

: "${PHOTOS_BUCKET:?}"
rm -f "$CS_DIR"/pd-batch-*
BATCH="${PHOTO_DELETE_BATCH:-1000}"
[[ $BATCH =~ ^[0-9]{1,4}$ ]] && [ "$BATCH" -ge 1 ] && [ "$BATCH" -le 1000 ] || BATCH=1000
split -l "$BATCH" -d -a 4 "$CS_DIR/pd-go" "$CS_DIR/pd-batch-"
ok=0
for b in "$CS_DIR"/pd-batch-*; do
  [ -s "$b" ] || continue
  # Keys of the photo shape hold no quote or backslash, so they are JSON as they are.
  { printf '{"Objects":['
    awk 'NR>1{printf ","} {printf "{\"Key\":\"%s\"}", $0}' "$b"
    printf '],"Quiet":true}'; } > "$b.json"
  aws_rw s3api delete-objects --bucket "$PHOTOS_BUCKET" --delete "file://$b.json" > "$b.out" || ok=1
done
gone=0
left=0
# Gone only on a definite "not found" (404 / NoSuchKey); a 403, a network error
# or throttling counts as still there, never as deleted.
while IFS= read -r k; do
  [ -n "$k" ] || continue
  rc=0
  AWS_ACCESS_KEY_ID="${CLEANSTART_R2_RW_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${CLEANSTART_R2_RW_SECRET_ACCESS_KEY:?}" \
    aws s3api head-object --bucket "$PHOTOS_BUCKET" --key "$k" --endpoint-url "https://${PHOTOS_R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com" \
    > /dev/null 2> "$CS_DIR/pd-head.err" || rc=$?
  cat "$CS_DIR/pd-head.err" >> "$CS_DIR/aws.log" 2>/dev/null || true
  if [ "$rc" -ne 0 ] && grep -qE '\((404|NoSuchKey|NotFound)\)|Not Found' "$CS_DIR/pd-head.err"; then gone=$((gone + 1)); else left=$((left + 1)); fi
done < "$CS_DIR/pd-go"
rm -f "$CS_DIR/pd-head.err"
listed="$(wc -l < "$CS_DIR/pd-list" | tr -d ' ')"
note "listed=$listed skipped_shape=$skipped_shape skipped_uat=$skipped_uat deleted_confirmed=$gone still_there=$left"
# For the in-app record only (photos-record.sql), never the log.
printf '%s %s %s %s\n' "$listed" "$skipped_shape" "$skipped_uat" "$gone" > "$CS_DIR/photo-delete.counts"
[ "$left" -eq 0 ] || ok=1
yes_no "every photo to delete is confirmed gone" "$ok"
[ "$ok" -eq 0 ] || refuse "a photo could not be deleted or is still there"
