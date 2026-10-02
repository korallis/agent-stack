### Fixed
- Native Grok and Kimi seats' instructions now say that a message sent while the seat was busy waits in the CLI's input
  queue and arrives later as its own turn: before acting on a queued notice about a row, check it with
  `rig queue show <id> --full --json` and skip it, without re-reporting, if it is already done or handed off. A busy
  seat replaying a backlog of old handoff notices had re-reported settled rows turn after turn.
