#!/usr/bin/env bash
# One production update cycle (same steps as the former single-run workflow).
# Always starts from the latest origin/main, so a failed or rejected earlier cycle never leaks into this one.
set -euo pipefail
PATHS=(odds.json dev/odds.json dev/official-results.json dev/official-previews.json dev/racer-aptitude-runtime.json.gz dev/course-stats-runtime.json dev/server-predictions.json dev/server-predictions-index.json dev/server-predictions-archive)
BASELINE="${RUNNER_TEMP:-/tmp}/prediction-history-baseline.json"
PUSHED_MARK="${CYCLE_PUSHED_MARK:-${RUNNER_TEMP:-/tmp}/cycle-pushed}"
rm -f "$PUSHED_MARK"

git fetch --quiet --depth=1 origin main
git reset --quiet --hard FETCH_HEAD
node scripts/verify_prediction_history.mjs dev "$BASELINE" --save-baseline

php scripts/fetch_live_odds.php
# Early in the morning the official pay page can legitimately contain no results yet; do not block fresh odds.
node scripts/fetch_official_results.mjs || echo "::warning::official results fetch failed; continuing"
node scripts/fetch_official_previews.mjs || echo "::warning::official preview fetch failed; continuing"
node scripts/build_runtime_payloads.mjs
node scripts/update_server_predictions.mjs
node scripts/backfill_expert_history.mjs
node scripts/verify_prediction_history.mjs dev "$BASELINE"

# porcelain also sees new untracked files (e.g. a new month archive), which git diff would miss.
if [ -z "$(git status --porcelain -- "${PATHS[@]}")" ]; then
  echo "No odds or prediction changes"
  exit 0
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
EXISTING=();for p in "${PATHS[@]}";do [ -e "$p" ] && EXISTING+=("$p");done
git add -A -- "${EXISTING[@]}"
git commit --quiet -m "chore: update live odds and predictions"
# A changed remote head rejects this commit; the next cycle starts again from the new origin/main.
git push --quiet origin HEAD:main
touch "$PUSHED_MARK"
