### Fixed
- Local CI runners: when `CI_LOCAL` is cleared (watch, a fail-closed registration, give-up, stop, remove), a run that
  still waits for a local runner is cancelled (force-cancel if refused) and re-run, so it goes hosted instead of
  sitting queued for ever. `register` records its network-guard check ("network guard holds: … (checked <time>)") in the journal and
  for the job, and the job-started hook prints it in every job's log (a missing record is reported, not refused).
  `netguard-install` uses `install -D` (the live install stopped on a missing `/usr/local/libexec`).
- A PR template that asks whether merging plus pulling changes live behaviour before an install step.
