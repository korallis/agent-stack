### Fixed
- Local CI runners: each runner instance gives its jobs its own `E2E_PORT` (stable, from 47100), so two runners of one
  repo no longer start their app servers on the same port. A project's parallel browser shards collided on its default
  port. `agent-ci-runner stop` also frees its runners' job slots, because a job stopped mid-run never reaches its
  job-completed hook.
- Local CI job gate: `end` frees its slot under the gate's lock. A job ending while another waited could delete a slot
  mid-sweep, and the waiting job's gate then failed (`stat` of a vanished file broke the age arithmetic).
- `test/authwatch.test.js` passes the test's `TZ` to the script, so the routing log's local times agree on a runner
  with `TZ=UTC` and a non-UTC host clock.
