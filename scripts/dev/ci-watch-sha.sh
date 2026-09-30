#!/usr/bin/env bash
# Wait for the CI run on exactly <commit>, print its conclusion and jobs, and EXIT WITH
# CI's RESULT: 0 only when the run succeeded.
#   bash scripts/dev/ci-watch-sha.sh <commit> [branch]
# <commit> may be short or full; it is resolved to the full SHA first, because GitHub
# matches the full one. `gh run list --limit 1` races a fresh push (CLAUDE.md, "Gate the
# merge on CI's exit code"): this matches the commit itself. Still read the printed
# conclusion before merging, and never chain a push after this script with && or ;.
SHA="$(git rev-parse --verify "${1:-}^{commit}" 2>/dev/null)" || { echo "usage: ci-watch-sha.sh <commit> [branch] (unknown commit: ${1:-none})"; exit 2; }
BRANCH="${2:-$(git branch --show-current)}"
echo "head:   $SHA"
echo "branch: $BRANCH"
RUN=""
for i in $(seq 1 60); do
  RUN=$(gh run list --branch "$BRANCH" --limit 20 --json databaseId,headSha,workflowName \
    --jq ".[] | select(.headSha==\"$SHA\" and .workflowName==\"CI\") | .databaseId" | head -1)
  [ -n "$RUN" ] && break
  sleep 10
done
if [ -z "$RUN" ]; then echo "no CI run for $SHA on $BRANCH"; exit 3; fi
echo "run $RUN"
gh run watch "$RUN" --exit-status > /dev/null 2>&1
WATCH=$?
echo "watch exit $WATCH"
gh run view "$RUN" --json conclusion,jobs --jq '.conclusion, (.jobs[] | "  \(.name): \(.conclusion)")'
exit "$WATCH"
