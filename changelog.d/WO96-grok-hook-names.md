### Fixed
- The native seats' idle keepalive now works for grok. grok names its hook events in both PascalCase and snake_case
  (`SessionStart`, `session_start`, `stop`), and the keepalive matched only `Stop`/`SessionStart`, so an idle grok seat
  still turned "unknown" and dropped out of pick-seat (seen on the live pilot after the #123 relaunch).
