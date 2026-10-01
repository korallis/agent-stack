# Seat start-up context (every seat in this rig)

## Who and where you are
- `rig whoami --json` gives your seat, rig and pod. Your working directory is your own git worktree
  (`@WT@/<your seat>`); the product repo is `@REPO@`; never build or commit from the shared checkout.
- The trunk is `@TRUNK@`: branch from `origin/@TRUNK@`, and every pull request targets `@TRUNK@`.
- The project workspace (missions, slices, wave maps) is `$OPENRIG_WORK_ROOT` (`@REPO@-work`). Read
  `project.yaml`, then the mission and slice your queue item names (`mission:` / `slice:` tags).
- Your role text arrived as your first message; the rig culture and this file are in your instruction file
  (`CLAUDE.local.md` for Claude seats, `AGENTS.md` for Codex seats). Re-read them after a compaction or when the
  lead says the rules changed.

## Skills to load (they are installed; open them when the moment comes)
- Everyone: `mission-slice-sop` (slice files, proof, handoffs), `queue-handoff` (end every turn by passing the
  ball), `openrig-project-setup` (how this project is wired), `agent-stack` (pool, Jev, tools).
- After a compaction: `claude-compaction-restore` / `session-compaction-and-restore`; near the context limit:
  `retiring-and-inheriting-a-seat`.
- Your role's own skills are listed in your role text and projected into your worktree.

## Environment
- Models come through the local pool (`agent-proxy-status` shows it). Never switch accounts yourself.
- Test servers: use `$E2E_PORT` (unique per seat), never a fixed port.
- Search with `rg`/`fd`; send tables to other seats as TOON.
- GitHub API is shared by every seat: poll at most once a minute, back off 2 minutes on a rate limit.

## System check (once at start, and after a restore)
1. `rig ps --nodes` shows your rig running and your seat ready.
2. `pwd` is your worktree and `git status` shows only your own work.
3. `node --version`, `gh auth status`, `rig queue list --owned` work.
4. `echo $OPENRIG_WORK_ROOT $E2E_PORT` are both set.
5. Seats on `claude-fable-5-1` (the architect): Fable bills to the account's usage credits, and an account may first
   need a one-time consent. If Claude Code asks for it, or says the model is unavailable, stop and tell the lead in
   one row: "Fable needs its one-time consent: run `/model fable` once in <your seat>, then relaunch me at idle".
   Never carry on silently on another model.
6. Your model is the one your rig pins (2026-10-01 routing): Codex seats `gpt-6.1-sol`; Claude test authors and UI
   implementers `claude-sonnet-5-5`; lead and Claude reviewers `claude-opus-5-5`; architect `claude-fable-5-1`; Kimi
   seats `kimi-k3`. If your footer shows another model, tell the lead.
If anything is missing, tell the lead in one message; don't work around it.
