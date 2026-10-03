### Fixed
- Local CI runners: a busy runner is no longer stopped for good by systemd's start limit. The ephemeral runner
  restarts after every job, so 20 short jobs in 10 minutes hit the old `StartLimitBurst=20` / 600 s, and one repo's
  runner stayed down until it was reset by hand. The unit has no start limit now. A failed registration leaves the runner stopped (`Restart=` doesn't retry a failed
  `Requires=` dependency), so `watch` starts it again every 2 minutes unless the repo is paused. A failing registration, or a runner that crashes (non-zero exit, read before each restart), backs off
  instead (after 3 failures in 10 minutes, each attempt waits 60 s first), which bounds registration-token requests, and
  a success clears it.
