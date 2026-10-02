# Seat startup

Run `rig whoami --json` and `rig queue whoami --json`. Your role arrives as a first message; its own skills load
when the task needs them. Your code worktree is `@WT@/<seat>`, product repo `@REPO@`.
The trunk is `@TRUNK@`: branch from `origin/@TRUNK@`, and every pull request targets `@TRUNK@`.
Do not build from the shared checkout.

Resolve `$OPENRIG_WORK_ROOT/project.yaml`, then the mission and slice named by your queue assignment. Check
`git status`, `$OPENRIG_WORK_ROOT` and `$E2E_PORT` before work. Test servers use that unique port.
After compaction, recover identity and queue custody, then use the runtime's compaction/restore skill.

The short culture is in your instruction file. Detailed procedures are under `$OPENRIG_WORK_ROOT/rig/guidance/`:
read only the section needed by the current work. `agent-stack` explains the pool and tools; `openrig-project-setup`
explains project wiring. `mission-slice-sop` and `queue-handoff` cover the work and its return.

Check your model against your member's `model:` in the rig spec. Report any mismatch to the lead; do not switch
accounts yourself. Fable may need one-time usage-credit consent: if requested or unavailable, tell the lead to
arrange `/model fable` consent and an idle relaunch. Do not silently continue on a different model.
