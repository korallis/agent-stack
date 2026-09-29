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
`~/.openrig` (database `~/.openrig/openrig.sqlite`), daemon unit `openrig.service`, seats' tmux server
`openrig-tmux.service`, target version `V`.

## 0. Before the window
- Read the release notes (`https://github.com/mvschwarz/openrig/releases/tag/v$V`) and the queue item's patch line.
  - "patches present? no", while the installed version carries patches: port them first (`patches/openrig/README.md`),
    or confirm upstream fixed them.
- Tell the rig leads the window time, and ask builders to finish or park their current step.

## Preflight: seats must not depend on openrig.service
`openrig-tmux-adopt` (dry run) must print "already safe", meaning the tmux server is not in `openrig.service` and no pane
scope is `PartOf=openrig.service`. If it doesn't, run `openrig-tmux-adopt --apply` (nothing is stopped) and re-check.
Don't continue until it is safe (the 2026-09-29 incident).

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

## 3. Install and patch, without restarting
```bash
openrig-upgrade --no-restart "$V" > ~/openrig-upgrade-$V/install.log 2>&1; echo "exit $?"
```
This runs `npm install` of `$V` into `$P`, the local patches (`bin/openrig-apply-patches`), the YOLO presets and the
shared-agent link. It then records `OPENRIG_VERSION`.
- It exits 1 before touching anything else when the installed package is not `$V`.
- The daemon is not restarted, but its files on disk have changed, so keep the time until step 5 short.
- **Stop on a non-zero exit.** Read `install.log`, then roll back the prefix (below). No restart has happened yet.

## 4. Observe the installed files (one surface at a time)
```bash
jq -r .version "$P/lib/node_modules/@openrig/cli/package.json"           # must be $V
grep "patches:" ~/openrig-upgrade-$V/install.log                         # "applied …" / "already applied …"
grep -c canonicalSenderSession "$P/lib/node_modules/@openrig/cli/daemon/dist/routes/require-sender-identity.js"  # >0 while #131 is carried
```
A patch warning means that fix is missing in `$V`. Decide now, before the restart, whether to roll back the prefix or
run without the fix (`patches/openrig/README.md`).

## 5. Restart only the daemon, then observe it
```bash
openrig-daemon-cycle --reason "upgrade to $V"; echo "exit $?"
rig --version; rig daemon status
curl -fsS http://127.0.0.1:7433/healthz | jq '{version, selfHostId}'
sqlite3 ~/.openrig/openrig.sqlite 'PRAGMA integrity_check'
```
`openrig-daemon-cycle` runs `rig daemon stop` and verifies that the old PID is gone and the port is closed; it never
signals anything. It then runs `rig daemon start` in its own scope with `openrig.service`'s environment and waits for
`/healthz`, then runs `rig up kernel --existing`. **Never** `systemctl stop|restart openrig.service` or
`openrig-tmux.service` while rigs run.
- Exit 1 at "STOP INCOMPLETE": the old daemon is still there. Inspect it (the skill's stop rules); don't signal a PID.
- Exit 1 at "START FAILED": roll back the prefix (below) and run `openrig-daemon-cycle --start-only`.

Stop and roll back if the version or listener is not the target, or if the database check fails.

## 6. Managed plugins: plan first
```bash
node "$SKILL_DIR/scripts/refresh-managed-plugin.mjs" \
  --ancestor "$P.rollback-<old>/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core" \
  --target "$P/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core" \
  --live "$HOME/.openrig/plugins/openrig-core"
```
Apply with `--apply-safe` only when the classifications make sense. Resolve locally modified paths one at a time.

## 7. Verify seats and specs, then a canary
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
Stopped at step 3 or 4, with no restart yet: `rm -rf "$P" && mv "$P.rollback-<old>" "$P"`, restore
`OPENRIG_VERSION=<old>` in `config/versions.env`, and check `jq -r .version` shows `<old>`. The daemon never left the old
code, so it needs no restart.

After the restart, prefer starting the previous runtime against the same database:
`openrig-daemon-cycle --stop-only`, `rm -rf "$P" && mv "$P.rollback-<old>" "$P"`, restore `OPENRIG_VERSION=<old>` in
`config/versions.env`, then `openrig-daemon-cycle --start-only`. Repeat the step 5 and 7 observations.

Restore `openrig-before.sqlite` only when a migration or corruption finding requires it; a degraded view is not that proof.

Record the outcome on the upgrade queue item: version, patches, what was observed, and the rollback path kept.
