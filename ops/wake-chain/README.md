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

## Midday hand-over (`handoff.mjs` / `handoff_gate.mjs`, production: `handoff-update.yml`)
Problem (10/20-10/23): the 07:00 update loop stops at its 5.5 h limit around 12:19 JST; its pending successor in the
shared concurrency group was cancelled at the same second a Recover run was created (10/20 01:52:30/01:52:28Z,
10/21 01:39:16/15, 10/22 01:34:09/08, 10/23 01:34:42/41 — timing match, cause not proven), and no update ran until a
late `schedule` start (~2 h without odds updates).
- Gate (end of the update run): only a normal stop at the run time limit with ok and no pending journal, the same JST
  date as the run start, before 21:00 JST, and at most 3 hand-overs per JST day. Never after failures, night/racing-hours
  stops or control-code stops. A failed gate/dispatch is an error annotation, the update run keeps its result.
- Waker (own concurrency group): waits until the parent run has completed and until no run of the shared group is
  queued/running (e.g. a pending Recover), stops if another update is active or started within 10 minutes, dispatches,
  confirms the dispatch created a run (accepted) and then that the run actually started; a run cancelled before
  starting is re-dispatched after the group is idle again, at most 3 times. All waits are bounded.
- DEV verification uses harmless probes in their own group (`handoff-probe-long.yml` plays Update,
  `handoff-probe-short.yml` plays Recover).

### DEV verification of the hand-over (2026-10-23, Actions, harmless probes)
- 22:18 JST: gate refused ("too_late_in_day", 21:00 limit) — run 39959814041
- 22:23 JST (hour limit lifted for the test only): parent 39960531260 handed over; the waker 39960807761 waited for the parent
  and for the pending short probe (Recover role, ran 13:23:39–13:24:21Z), then stopped with "recent_run" because a long
  probe from the first test had started within 10 minutes (deduplication working)
- 22:34 JST, clean run: parent 39962370352 (13:34:42–13:36:46Z) dispatched the waker 39962648058 at 13:36:42Z while still
  running; the short probe 39962433955, queued at 13:35:09Z, ran after the parent until 13:37:31Z; the group was idle at
  13:37:40Z; dispatch 13:37:40.5Z; the new long probe 39962783960 actually started 13:37:41Z ("started")
- Not covered live (unit tests only): cancel-before-start and re-dispatch, dispatch 5xx, bounded-wait failures, journal
  pending / failures (the gate refuses those)

- Production: the last step of "Update live odds" runs the gate; `handoff-update.yml` (own concurrency group, 60-min job,
  45-min overall deadline) runs the waker with target update-live-odds.yml and group update-live-odds.yml +
  settle-pending-results.yml. Only a parent whose final conclusion is success is handed over; while waiting for an idle
  group it stops as soon as another update runs or started within 10 minutes. The concurrency groups are unchanged.
