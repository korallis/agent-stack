### Fixed
- Local CI runners: each runner instance gives its jobs its own `E2E_PORT` (stable, from 47100), so two runners of one
  repo no longer start their app servers on the same port. A project's parallel browser shards collided on its default
  port. `agent-ci-runner stop` also frees its runners' job slots, because a job stopped mid-run never reaches its
  job-completed hook.
