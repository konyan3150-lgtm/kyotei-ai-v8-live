#!/usr/bin/env bash
# Commit and push generated files that only this workflow writes, surviving pushes from other workflows.
# On a rejected push it starts again from the latest origin/main and puts the generated files back on top
# (never a merge or rebase of other files). Usage: commit_paths.sh "message" PATH...
set -euo pipefail
MSG="$1"; shift
PATHS=("$@")
KEEP="$(mktemp -d)"
trap 'rm -rf "$KEEP"' EXIT
for p in "${PATHS[@]}"; do [ -e "$p" ] && { mkdir -p "$KEEP/$(dirname "$p")"; cp -p "$p" "$KEEP/$p"; }; done
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
for attempt in 1 2 3 4; do
  if [ "$attempt" -gt 1 ]; then
    git fetch --quiet --depth=1 origin main
    git reset --quiet --hard FETCH_HEAD
    for p in "${PATHS[@]}"; do [ -e "$KEEP/$p" ] && { mkdir -p "$(dirname "$p")"; cp -p "$KEEP/$p" "$p"; }; done
  fi
  if [ -z "$(git status --porcelain -- "${PATHS[@]}")" ]; then echo "No changes to commit"; exit 0; fi
  git add -A -- "${PATHS[@]}"
  git commit --quiet -m "$MSG"
  if git push --quiet origin HEAD:main; then echo "Pushed on attempt $attempt"; exit 0; fi
  echo "::warning::push rejected (attempt $attempt); retrying from the latest origin/main"
  sleep $((attempt * 3))
done
echo "::error::push failed after 4 attempts"
exit 1
