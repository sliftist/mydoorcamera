#!/usr/bin/env bash
# One-shot "ship it": typecheck, build, stage everything, commit, and deploy.
#
# Usage: yarn ship "commit message"
#
# This bundles the whole mandatory ship sequence into a single command so it
# can be run (and allow-listed) as one atomic step instead of a chain of piped
# git calls. `yarn deploy` (scripts/deploy.js) does the actual `git push
# origin <branch>` before building + pushing gh-pages, so this script covers
# add + commit + push + deploy end to end.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MSG="${1:-}"
if [ -z "$MSG" ]; then
    echo "Usage: yarn ship \"commit message\"" >&2
    exit 1
fi

echo "==> yarn type"
yarn type

echo "==> yarn build-web"
yarn build-web

echo "==> git add -A"
git add -A

if git diff --cached --quiet; then
    echo "==> Nothing to commit — deploying current HEAD."
else
    echo "==> git commit"
    git commit -m "$MSG"
fi

# yarn deploy pushes the current branch first, then builds + pushes gh-pages.
yarn deploy
