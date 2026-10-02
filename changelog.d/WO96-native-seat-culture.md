### Fixed
- Native grok/kimi seats in a real project:
  - They start with the rig's culture. OpenRig gives a seat neither its workspace nor `OPENRIG_WORK_ROOT`, and seat
    worktrees sit outside the workspace, so `agent-native-seat` stopped with "no rig CULTURE.md". standard.yaml now
    passes `--culture @W@/rig/CULTURE.md`, which `agent-project-new` fills in. The launcher also finds
    `<P>-work/rig/CULTURE.md` beside a `<P>.worktrees/<seat>` worktree.
  - They stay dispatchable while idle. OpenRig trusts a hook report for 5 minutes and doesn't read terminal seats'
    screens, so an idle native seat turned "unknown" and `agent-dispatch pick-seat` stopped listing it (seen on the
    first live pilot). The launcher repeats `idle` every 2 minutes while the CLI is idle: grok by its last hook,
    which now passes through `agent-native-seat hook` (it notes only the event's name); kimi by its progress
    sequences.
- `agent-refresh-guidance` skips terminal members. It wanted to restore OpenRig blocks into the project's own
  AGENTS.md in a native seat's worktree. Without PyYAML, or when the spec doesn't parse, it reads the members line
  by line and keeps the exclusion (`runtime: terminal`, `builtin:terminal`, `agent-native-seat`). If a `cwd` can't be
  tied to a member, `--apply` writes nothing and says why.
