### Added
- `agent-refresh-guidance.timer` (every 5 minutes) runs `agent-refresh-guidance-all`, which runs `agent-refresh-guidance --apply` for
  every running project rig. A CULTURE, role, startup or launcher edit reaches running seats, and a busy native seat
  owed a re-read is told once idle, without anyone re-running it by hand. A rig is skipped when its sources' hash is
  unchanged and none of its seats is owed a re-read; stopped rigs are never touched; one log line per action.
