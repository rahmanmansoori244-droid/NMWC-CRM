#!/usr/bin/env bash
# After `git push origin <sha>:refs/heads/main`: wait for production to serve a new
# build, smoke it, then wait for main's CI on <sha> and print its post-deploy smoke.
#   bash scripts/dev/deploy-watch.sh <commit> <build id before the push>
# The build ID before the push comes from `node scripts/dev/build-id.cjs`.
# Exit 0 only when the build changed, smoke passed and main's CI succeeded.
set -o pipefail
SHA="$(git rev-parse --verify "${1:-}^{commit}" 2>/dev/null)" || { echo "usage: deploy-watch.sh <commit> <old build id> (unknown commit: ${1:-none})"; exit 2; }
OLD="${2:-}"
if ! [[ "$OLD" =~ ^[A-Za-z0-9_-]{10,}$ ]]; then echo "usage: deploy-watch.sh <commit> <old build id> (not a build id: '$OLD')"; exit 2; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$HERE" rev-parse --show-toplevel)" || exit 2
FAIL=0
NEW=""
CHANGED=0
for i in $(seq 1 90); do
  # build-id.cjs prints an ID only on success; a failed fetch is retried, never read as new.
  if NEW=$(node "$HERE/build-id.cjs" 2>/dev/null) && [[ "$NEW" =~ ^[A-Za-z0-9_-]{10,}$ ]] && [ "$NEW" != "$OLD" ]; then
    echo "build ID changed after ~$((i * 10))s: $OLD -> $NEW"
    CHANGED=1
    break
  fi
  sleep 10
done
if [ "$CHANGED" != 1 ]; then echo "build ID did NOT change within 15 min"; FAIL=1; fi
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
