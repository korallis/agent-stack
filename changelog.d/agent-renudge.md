### Added
- `agent-reroute` also re-nudges once (agent-renudge). A handoff row that is pending and unclaimed for 10+ minutes, whose
  nudge was delivered, gets one reminder to its seat if that seat is running, servable and idle now. A Codex seat had seen
  a handoff mid-turn, finished its other work, never claimed it, and lost it at the next context compaction: the
  message wasn't dropped, and no daemon path re-delivers it. Human and owner rows are never touched, and each row gets
  at most one reminder.
