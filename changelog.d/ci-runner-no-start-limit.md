### Fixed
- Local CI runners: a busy runner is no longer stopped for good by systemd's start limit. The ephemeral runner
  restarts after every job, so 20 short jobs in 10 minutes hit the old `StartLimitBurst=20` / 600 s, and one repo's
  runner stayed down until it was reset by hand. The unit has no start limit now. A failed registration leaves the runner stopped (`Restart=` doesn't retry a failed
  `Requires=` dependency), so `watch` starts it again every 2 minutes unless the repo is paused. Failed registrations and abnormal runner exits (non-zero, read before each restart) back off instead:
  from the 3rd in 30 minutes each start waits 60, 120, 240 s; at the 6th the runner is given up (stopped, `CI_LOCAL`
  cleared so jobs run hosted, logged) until `agent-ci-runner start`. A clean exit 0 never counts.
