### Added
- `agent-native-seat <grok|kimi> --role <role>`: runs the native grok or kimi CLI as an OpenRig terminal seat (WO88).
  It writes the seat's culture and role where the CLI reads project rules (never over the project's AGENTS.md), wires
  busy/idle into OpenRig's activity ingest (grok through its own hooks and OpenRig's relay, kimi from its progress
  sequences), keeps grok from loading the Claude seats' settings, pre-trusts kimi's folder, turns off both auto-updates,
  runs never-prompt, and resumes the seat's own session on restore. It also turns tmux's extended-keys Ctrl+M, which is
  how OpenRig submits, into Enter: kimi never submits otherwise (mvschwarz/openrig#496). Proven on a throwaway rig: both
  seats took a queue row, did the task, closed the row, and `rig send --wait-for-idle` delivered.
