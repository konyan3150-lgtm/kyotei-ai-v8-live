# Wake chain

Goal: start the production update at 07:00 JST every morning even when GitHub's `schedule` does not fire.
Scope: a helper inside GitHub Actions against missing `schedule` starts. It is not independent of GitHub itself
(an Actions outage stops it too); an external trigger outside GitHub is a separate topic (see ops/external-scheduler)
(10/14: no scheduled start between 07:00 and 09:53 JST, and none at all after 22:07 JST).

## How it works
- A waker run sleeps at most 330 minutes (below the 6-hour job limit). If the target time is further away it
  dispatches the next waker (`hop`, at most 3), otherwise it waits until the target time.
- At the target time it dispatches the target workflow via `workflow_dispatch` — unless the target is active
  (queued / in progress / waiting / pending / requested) or started within the last 10 minutes.
- Each dispatch is confirmed: a matching new run must appear within 3 minutes, otherwise the waker fails.
  A 5xx answer can still have created the run (seen in DEV: HTTP 502 with the run created), so the waker first looks
  for the run. It dispatches once more only if the run list was read successfully until the deadline and showed no
  such run. If the list cannot be read (403, 503, timeout, invalid answer) the result is unknown: no second dispatch,
  the waker fails. 4xx answers to the dispatch fail at once.
- Targets more than 3 hours past are skipped (`stale_target`), so a delayed chain never starts work at a wrong time.

## Credentials
Only the job's own `GITHUB_TOKEN`, with `actions: write` and `contents: read` on this repository.
Dispatches made with `GITHUB_TOKEN` do start `workflow_dispatch` runs (the production update loop already dispatches
Pages this way). No personal access token, no external service, nothing stored. The target is allowlisted in the workflow.

## Duplicate suppression
- A waker started without a target (schedule or by hand) only hands over to a waker whose run title names the
  target (`normalized`). Wakers for the same target see each other by that title; the oldest active one stays and
  the others exit (`duplicate_waker`), checked before sleeping and again right before dispatching. A hop ignores its parent.
- The target is never dispatched while it is active or ran recently, and the target's own concurrency group still applies.
- These guards reduce duplicates; they are not an exactly-once guarantee.

## Failure record
Every run writes its decision as JSON to the job summary and as an annotation (readable through the API: check-runs annotations). API errors, a rejected or unconfirmed
dispatch, a non-allowlisted target, an unknown run status and too many hops fail the run (red in Actions).

## Starters
- At the end of the night update loop (dispatch the waker for the next 07:00), and
- a few `schedule` fallbacks in the evening (e.g. 21:40 / 22:40 / 23:40 JST): unreliable on their own, deduplicated.
If every starter is missed the chain does not run that night; the existing `schedule` remains as before.

## Cost / limits
A sleeping runner for about 7 hours per night (public repository: no Actions minutes charged).
GitHub runners can themselves be delayed or fail; this removes the dependency on `schedule`, not on GitHub.

## DEV tests
`node ops/wake-chain/test.mjs` (simulated GitHub and clock), plus real runs against `wake-probe.yml` in Actions.

## Production (kyotei-ai-v8-live)
- `.github/workflows/wake-update.yml`: target fixed to `update-live-odds.yml` (allowlist), target time 07:00 JST.
- Starters: the last step of every "Update live odds" run between 21:00 and 04:59 JST dispatches it (handover), and
  fallback schedules at 21:40 / 22:40 / 23:40 / 06:40 JST. Untargeted starts hand over to one titled waker per target;
  the oldest active one stays, the others exit (`duplicate_waker`).
- The target is not started while "Update live odds" is queued/running or started within the last 10 minutes; its
  concurrency group (shared with Recover) still applies. The existing `schedule` of the update stays as before.
- Verified in DEV (kyotei-ai-v8-dev): hops and 07:00 start (probe run 38644485169 started 07:00:07 JST on 10/15),
  duplicates, already-running/recent target, allowlist, 5xx and failed-confirmation handling.
