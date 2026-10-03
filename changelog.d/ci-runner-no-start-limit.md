### Fixed
- Local CI runners: a busy runner is no longer stopped for good by systemd's start limit. The ephemeral runner
  restarts after every job, so 20 short jobs in 10 minutes hit the old `StartLimitBurst=20` / 600 s, and one repo's
  runner stayed down until it was reset by hand. The unit has no start limit now. A failing registration backs off
  instead (after 3 failures in 10 minutes, each attempt waits 60 s first), which bounds registration-token requests, and
  a success clears it.
