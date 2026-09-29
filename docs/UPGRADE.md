# Upgrading OpenRig (operator window)

Project rigs run around the clock, so OpenRig is never upgraded automatically. Every Monday the `openrig-update.timer`
checks npm. When a newer release exists, it raises one queue item for the upgrade owner (`operator-agent@kernel`):
"upgrade window due: <from> -> <to>, patches present? yes/no". The owner schedules a window and follows this page.
Close that item with the outcome.

This page is the host-specific wrapper around OpenRig's own `openrig-upgrade` skill
(`~/.local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/daemon/specs/agents/shared/skills/core/openrig-upgrade/SKILL.md`,
below `$SKILL_DIR`). Its rule applies throughout: **one mutation at a time, then observe the effect before the next one.**
Seats live in tmux and survive a daemon restart. Never use `rig down` as part of an upgrade.

Paths: install prefix `P=~/.local/share/agent-stack/openrig`, package `$P/lib/node_modules/@openrig/cli`, state
`~/.openrig` (database `~/.openrig/openrig.sqlite`), service `openrig.service`, target version `V`.

## 0. Before the window
- Read the release notes (`https://github.com/mvschwarz/openrig/releases/tag/v$V`) and the queue item's patch line.
  - "patches present? no", while the installed version carries patches: port them first (`patches/openrig/README.md`),
    or confirm upstream fixed them.
- Tell the rig leads the window time, and ask builders to finish or park their current step.

## 1. Census and snapshots
```bash
mkdir -p ~/openrig-upgrade-$V
node "$SKILL_DIR/scripts/inspect-upgrade.mjs" > ~/openrig-upgrade-$V/inspect-before.json
rig ps --nodes -A --json > ~/openrig-upgrade-$V/nodes-before.json      # -A: every rig on this host
tmux ls > ~/openrig-upgrade-$V/tmux-before.txt
for r in $(rig ps --json | jq -r '.[].name'); do rig snapshot "$r"; done
```
Stop if a protected tmux session is already missing.

## 2. Verified database backup and a rollback copy of the install
```bash
node "$SKILL_DIR/scripts/backup-sqlite.mjs" --source ~/.openrig/openrig.sqlite \
  --destination ~/openrig-upgrade-$V/openrig-before.sqlite           # refuses to overwrite; runs integrity_check
cp -a "$P" "$P.rollback-$(rig --version | awk '{print $1}')"          # the exact runtime to roll back to
```
Stop if the integrity check fails.

## 3. Install the target and restart once
```bash
openrig-upgrade "$V" 2>&1 | tee ~/openrig-upgrade-$V/upgrade.log
```
In order, it runs `npm install` of `$V`, the local patches (`bin/openrig-apply-patches`), and the YOLO presets and
shared-agent link. It records `OPENRIG_VERSION=$V`, then restarts through `systemctl --user restart openrig.service`,
whose `ExecStartPost` re-attaches the kernel rig with `--existing`. Seats in tmux keep running.

## 4. Observe
Check one surface at a time:
```bash
grep "patches:" ~/openrig-upgrade-$V/upgrade.log   # "applied …" / "already applied …"; a warning = that fix is missing
systemctl --user status openrig.service --no-pager
rig --version; rig daemon status
curl -fsS http://127.0.0.1:7433/healthz | jq '{version, selfHostId}'
sqlite3 ~/.openrig/openrig.sqlite 'PRAGMA integrity_check'
```
Stop if the process path, listener or version is not the target, or the database check fails; then roll back (below).
A patch warning means that fix is missing in `$V`. Decide whether to roll back or run without it
(`patches/openrig/README.md`).

## 5. Managed plugins: plan first
```bash
node "$SKILL_DIR/scripts/refresh-managed-plugin.mjs" \
  --ancestor "$P.rollback-<old>/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core" \
  --target "$P/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core" \
  --live "$HOME/.openrig/plugins/openrig-core"
```
Apply with `--apply-safe` only when the classifications make sense. Resolve locally modified paths one at a time.

## 6. Verify seats and specs, then a canary
```bash
rig ps --nodes -A --json > ~/openrig-upgrade-$V/nodes-after.json      # compare with nodes-before.json
openrig-update --validate                                              # every rig/template spec on the new version
agent-never-prompt-check                                               # no seat can prompt
agent-project-check <P>                                                # for each project
```
- Canary: one queue round trip on a low-risk seat (create → claim → update → done) and one `rig send`/`rig capture`.
- Then `rig restore-check` where it applies.
- Tell the leads the window is over.

## Rollback
Prefer starting the previous runtime against the same database:
`systemctl --user stop openrig.service`, `rm -rf "$P" && mv "$P.rollback-<old>" "$P"`, restore `OPENRIG_VERSION=<old>`
in `config/versions.env`, then `systemctl --user start openrig.service`. Repeat the step 4 and 6 observations.

Restore `openrig-before.sqlite` only when a migration or corruption finding requires it; a degraded view is not that proof.

Record the outcome on the upgrade queue item: version, patches, what was observed, and the rollback path kept.
