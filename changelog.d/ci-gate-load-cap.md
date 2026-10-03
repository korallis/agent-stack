### Fixed
- Local CI runners: `agent-ci-runner start` leaves an already-active runner alone. Starting it again also started its
  register unit, which re-extracts the runner and wipes its home under a running job.
- Local CI job gate: a job also waits while load1 is above `AGENT_CI_MAX_LOAD` (default 24), not only above the CPU
  count. Two parallel browser jobs plus the seats pushed load1 to about 35 on a 32-CPU host, and UI tests timed out.
