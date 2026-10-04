### Fixed
- Local CI runners: `agent-ci-runner` logged every line twice under systemd, from two pids, which read as two overlapping
  `watch` runs. stdout already goes to the journal, so `logger` is now used only outside systemd (no `JOURNAL_STREAM`).
  `watch` also takes a non-blocking lock, so a second concurrent run, such as a manual call during the timer's, exits
  quietly.
