#!/usr/bin/env bash
# After `git push origin <sha>:refs/heads/main`: wait for production to serve a new
# deployment, check it serves <sha>, smoke it, then wait for main's CI on <sha> and
# print its post-deploy smoke.
#   bash scripts/dev/deploy-watch.sh <commit> <deployment id before the push>
# The deployment ID before the push comes from `node scripts/dev/build-id.cjs`: Vercel's
# dpl_… ID (since Next 16 the page has no Next build ID; a Next 15 page's build ID is
# still read when the page has no deployment ID, see build-id.cjs).
# Exit 0 only when the deployment changed, it does not serve another commit, smoke
# passed and main's CI succeeded.
# DEPLOY_WATCH_TRIES / DEPLOY_WATCH_EVERY (default 90 x 10 s) set how long it waits.
set -o pipefail
SHA="$(git rev-parse --verify "${1:-}^{commit}" 2>/dev/null)" || { echo "usage: deploy-watch.sh <commit> <old deployment id> (unknown commit: ${1:-none})"; exit 2; }
OLD="${2:-}"
if ! [[ "$OLD" =~ ^[A-Za-z0-9_-]{10,}$ ]]; then echo "usage: deploy-watch.sh <commit> <old deployment id> (not a deployment id: '$OLD')"; exit 2; fi
TRIES="${DEPLOY_WATCH_TRIES:-90}"
EVERY="${DEPLOY_WATCH_EVERY:-10}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$HERE" rev-parse --show-toplevel)" || exit 2
FAIL=0
NEW=""
CHANGED=0
for i in $(seq 1 "$TRIES"); do
  # build-id.cjs prints an ID only on success; a failed fetch is retried, never read as new.
  if NEW=$(node "$HERE/build-id.cjs" 2>/dev/null) && [[ "$NEW" =~ ^[A-Za-z0-9_-]{10,}$ ]] && [ "$NEW" != "$OLD" ]; then
    echo "deployment changed after ~$((i * EVERY))s: $OLD -> $NEW"
    CHANGED=1
    break
  fi
  sleep "$EVERY"
done
WAITED=$((TRIES * EVERY))
if [ "$WAITED" -ge 60 ]; then SPAN="$((WAITED / 60)) min"; else SPAN="${WAITED} s"; fi
if [ "$CHANGED" != 1 ]; then echo "deployment did NOT change within $SPAN"; FAIL=1; fi
# The commit the new deployment's page code was built from. A different commit is a
# failure (a rollback, or another push, is live); an unreadable one is only a warning,
# because main's post-deploy smoke checks the commit with the monitor bearer.
if [ "$CHANGED" = 1 ]; then
  LIVE=""
  for i in 1 2 3; do
    LIVE=$(node "$HERE/build-id.cjs" --commit 2>/dev/null) && [ -n "$LIVE" ] && break
    LIVE=""
    sleep 5
  done
  if [ -z "$LIVE" ]; then
    echo "WARN  the commit could not be read from the page code; main's post-deploy smoke checks it"
  elif [ "$LIVE" = "$SHA" ]; then
    echo "production serves $SHA"
  else
    echo "production serves $LIVE, not $SHA"
    FAIL=1
  fi
fi
if ! npm run smoke 2>&1 | tail -2; then echo "smoke FAILED"; FAIL=1; fi
ID=""
for i in $(seq 1 30); do
  ID=$(gh run list --branch main --limit 10 --json databaseId,headSha,name --jq ".[] | select(.headSha==\"$SHA\" and .name==\"CI\") | .databaseId" | head -1)
  [ -n "$ID" ] && break
  sleep 10
done
if [ -z "$ID" ]; then echo "no CI run on main for $SHA"; exit 3; fi
echo "main run $ID"
gh run watch "$ID" --exit-status > /dev/null 2>&1
WATCH=$?
echo "watch exit $WATCH"
[ "$WATCH" = 0 ] || FAIL=1
gh run view "$ID" --json jobs,conclusion,headSha --jq '"\(.conclusion) \(.headSha[0:7])", (.jobs[] | "  \(.name): \(.conclusion)")'
gh run view "$ID" --log 2>/dev/null | grep -E "PASS  production is running|PASS  monitor bearer|FAIL|checks passed|checks failed" | sed 's/^.*\t//' | tail -6 || true
exit "$FAIL"
