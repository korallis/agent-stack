### Changed
- `agent-refresh-guidance --apply` brings native grok/kimi seats up to date after a CULTURE.md or role edit. It
  regenerates their rules file with `agent-native-seat --dry-run`, so it matches what a start writes, and tells an
  idle seat to re-read it. A busy seat is listed as pending and never interrupted. A re-read still owed (busy, or the
  send failed) is kept in the agent-stack state directory and retried on the next `--apply` at idle until one send
  succeeds. The launcher is recognised by its executable name in any path form; a start command that doesn't parse is
  reported. Before, a culture edit reached
  native seats only through a relaunch.
- `agent-project-check` takes native seats' staleness from `agent-refresh-guidance`, so its remedy for them is the same
  (`run agent-refresh-guidance --apply`) instead of a relaunch, and the check and the refresh can't disagree.
