# Authorized follow-up production guards

User authorization: after completing exclusion display and future-information safeguards, publish the tested change to production (2026-10-10 JST).

- UI distinguishes confirmed excluded outcomes from pending/cancelled results. Ordinary money, selection analysis and device audit exclude these outcomes while preserving saved purchases.
- Saves require aptitude history ending before race date and a per-race timestamp strictly before close minus 60 seconds. Exact bytes of the locally checked-out model are SHA256 hashed; model/aptitude/closing provenance survives compaction. Legacy provenance remains unknown; no retrospective inference.
- Empty EV data caused by missing odds is not a saved skip. Only unsaved EV modes initialize when odds become available, with their own saved-time provenance. Existing V8 and EV purchases remain frozen.
- Attached training sources are adapted in `experiments/training-v8`. Training, calibration, rule selection and reported test dates are disjoint. The supplied CSV has 41,441 train / 3,611 calibration / 3,251 selection / 6,998 test races. Unknown targets are removed; reverse/overlapping/duplicate race splits fail. No retraining or model replacement is included in deployment. Previously reported test results are not a fresh holdout; future evaluation uses shadow records.
- The historical static aptitude A/B includes later results and is not adoption evidence. Its production workflow is retired; existing result data is retained. The chronological official-history comparison and prospective shadow are separate development evidence, not claimed profit improvement.
- Production runs use fresh GitHub-hosted checkouts. All JSON outputs are staged/validated; final publication is one Git commit after count/key AND saved-purchase guards. Updater and recovery share concurrency. A changed remote head rejects push; there is no rebase of computed history. A crash cannot publish a partial file set. Local multi-file writes are not a transaction and are discarded with a failed run.
- Deployment changes code/workflows/UI only. Model and all existing production data are excluded from the deployment tree. Subsequent ordinary scheduled updates may append future records or settle pending results.

Validation includes regression tests, midnight browser checks, isolated current-day inference against a copy of production data, and read-only monetary/history audits. Post-deployment checks must confirm updater/recovery and Pages success and preservation of pre-deployment saved purchases.

Remaining evidence limits: synthetic special-payout markup (with real normal-page parser regression); original training feature timestamps cannot be reconstructed; existing legacy cancellations are not retrospectively repaired. These are not used to assert higher ROI.
