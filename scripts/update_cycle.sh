#!/usr/bin/env bash
# One production update cycle (same steps as the former single-run workflow).
# Always starts from the latest origin/main, so a failed or rejected earlier cycle never leaks into this one,
# except pre-close purchases, which are kept in a journal (scripts/carry_preclose_saves.mjs) until origin holds them,
# because they cannot be redone after close.
set -euo pipefail
PATHS=(odds.json dev/odds.json dev/official-results.json dev/official-previews.json dev/racer-aptitude-runtime.json.gz dev/course-stats-runtime.json dev/server-predictions.json dev/server-predictions-index.json dev/server-predictions-archive)
TMP="${RUNNER_TEMP:-/tmp}"
BASELINE="$TMP/prediction-history-baseline.json"
PUSHED_MARK="${CYCLE_PUSHED_MARK:-$TMP/cycle-pushed}"
JOURNAL="${CYCLE_CARRY_FILE:-$TMP/v8-journal/preclose-journal.json}"
rm -f "$PUSHED_MARK"

git fetch --quiet --depth=1 origin main
git reset --quiet --hard FETCH_HEAD
BASE="$(git rev-parse HEAD)"
# Untracked leftovers of a failed cycle (e.g. a new month archive without its index entry) are removed,
# only inside the generated data paths; scripts/vendor and other caches are never touched.
git clean -fdq -- "${PATHS[@]}"
# Journal entries origin already holds are closed; the rest are put back where origin lacks them (never overwriting origin).
node scripts/carry_preclose_saves.mjs confirm dev "$JOURNAL"
node scripts/carry_preclose_saves.mjs apply dev "$JOURNAL"
node scripts/verify_prediction_history.mjs dev "$BASELINE" --save-baseline

php scripts/fetch_live_odds.php
# Early in the morning the official pay page can legitimately contain no results yet; do not block fresh odds.
node scripts/fetch_official_results.mjs || echo "::warning::official results fetch failed; continuing"
node scripts/fetch_official_previews.mjs || echo "::warning::official preview fetch failed; continuing"
node scripts/build_runtime_payloads.mjs
node scripts/update_server_predictions.mjs
# New purchases are journaled as soon as they are written and the history is valid, before any later step can fail.
node scripts/verify_prediction_history.mjs dev "$BASELINE"
node scripts/carry_preclose_saves.mjs capture dev "$JOURNAL" "$BASE"
node scripts/backfill_expert_history.mjs
node scripts/verify_prediction_history.mjs dev "$BASELINE"

# porcelain also sees new untracked files (e.g. a new month archive), which git diff would miss.
if [ -z "$(git status --porcelain -- "${PATHS[@]}")" ]; then
  echo "No odds or prediction changes"
  exit 0
fi
# Capture again right before the commit (append-only, atomic; existing entries are never replaced).
node scripts/carry_preclose_saves.mjs capture dev "$JOURNAL" "$BASE"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
EXISTING=();for p in "${PATHS[@]}";do [ -e "$p" ] && EXISTING+=("$p");done
git add -A -- "${EXISTING[@]}"
git commit --quiet -m "chore: update live odds and predictions"
if ! git push --quiet origin HEAD:main; then
  echo "::warning::push rejected (origin moved); pre-close purchases stay in the journal for the next cycle"
  exit 75
fi
touch "$PUSHED_MARK"
# The working tree is now origin/main: close the journal entries it holds.
node scripts/carry_preclose_saves.mjs confirm dev "$JOURNAL"
