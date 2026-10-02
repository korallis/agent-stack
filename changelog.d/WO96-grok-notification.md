### Fixed
- Native grok seats stay dispatchable after a turn. grok sends a Notification hook after every Stop, and the launcher
  recorded it as the seat's last hook, so the idle keepalive stopped and an idle seat expired to "unknown" (seen live
  on a project rig after its Grok seats' first tasks). Only turn events (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Stop, SessionEnd) update the record now. Every payload is still relayed unchanged.
