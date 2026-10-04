### Fixed
- Local CI runners: when `CI_LOCAL` is cleared (watch, a fail-closed registration, give-up, stop, remove), a run that
  still waits for a local runner is cancelled (force-cancel if refused) and re-run, so it goes hosted instead of
  sitting queued for ever. `register` logs "network guard holds" on success, so each job's check is in the journal.
  `netguard-install` uses `install -D` (the live install stopped on a missing `/usr/local/libexec`).
- A PR template that asks whether merging plus pulling changes live behaviour before an install step.
