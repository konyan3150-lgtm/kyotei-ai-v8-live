#!/usr/bin/env bash
# One production update cycle (same steps as the former single-run workflow).
# Always starts from the latest origin/main, so a failed or rejected earlier cycle never leaks into this one,
# except pre-close saves, which are carried over (scripts/carry_preclose_saves.mjs) because they cannot be redone after close.
set -euo pipefail
PATHS=(odds.json dev/odds.json dev/official-results.json dev/official-previews.json dev/racer-aptitude-runtime.json.gz dev/course-stats-runtime.json dev/server-predictions.json dev/server-predictions-index.json dev/server-predictions-archive)
TMP="${RUNNER_TEMP:-/tmp}"
BASELINE="$TMP/prediction-history-baseline.json"
PUSHED_MARK="${CYCLE_PUSHED_MARK:-$TMP/cycle-pushed}"
CARRY="${CYCLE_CARRY_FILE:-$TMP/preclose-carry.json}"
rm -f "$PUSHED_MARK"

git fetch --quiet --depth=1 origin main
git reset --quiet --hard FETCH_HEAD
BASE="$(git rev-parse HEAD)"
# Untracked leftovers of a failed cycle (e.g. a new month archive without its index entry) are removed,
# only inside the generated data paths; scripts/vendor and other caches are never touched.
git clean -fdq -- "${PATHS[@]}"
# Put back pre-close saves from a rejected push that origin does not have yet (never overwrites origin).
node scripts/carry_preclose_saves.mjs apply dev "$CARRY"
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
  rm -f "$CARRY"
  exit 0
fi
# Keep this cycle's pre-close saves aside in case the push is rejected.
node scripts/carry_preclose_saves.mjs capture dev "$CARRY" "$BASE"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
EXISTING=();for p in "${PATHS[@]}";do [ -e "$p" ] && EXISTING+=("$p");done
git add -A -- "${EXISTING[@]}"
git commit --quiet -m "chore: update live odds and predictions"
if ! git push --quiet origin HEAD:main; then
  echo "::warning::push rejected (origin moved); pre-close saves kept for the next cycle"
  exit 75
fi
rm -f "$CARRY"
touch "$PUSHED_MARK"
