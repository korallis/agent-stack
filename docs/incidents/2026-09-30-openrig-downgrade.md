# 2026-09-30 08:47Z: install.sh downgraded OpenRig 0.6.1 to 0.5.17

## What happened
Re-running `./install.sh` reinstalled OpenRig **0.5.17** over **0.6.1**. For about 9 minutes the daemon ran unpatched
0.5.17 against a database that 0.6.1 had already migrated.
- A rig created in that window (fortis) came up on the old version.
- With local patch 133 gone, a stuck-sweep alert paged the owner.

## Why
- `install.sh` reinstalled `OPENRIG_VERSION` whenever `rig --version` differed from it, in either direction.
- The pin lived only in the local, untracked `config/versions.env`, and the 0.6.1 upgrade the day before had never
  recorded 0.6.1 there. So the stale pin said 0.5.17.

## Recovery
At 08:56Z the operator ran `openrig-upgrade 0.6.1`: 0.6.1 plus local patches 131–139 applied, the pin set to 0.6.1.
All rigs were intact, with 0 dead panes.

## Prevention (WO23, PR #25)
- `openrig-ensure` (install.sh's OpenRig step) installs only when OpenRig is missing or the pin is NEWER; a newer
  install is kept and the pin follows it.
- `openrig-upgrade` refuses an older version unless `--allow-downgrade`. It resolves the target first (drops a
  leading `v`, turns a dist-tag into an exact version) and compares by SemVer (`bin/semver-cmp`: a prerelease is below
  its release).
- The defaults are tracked in git (`config/versions.defaults.env`); `config/versions.env` is only a local override.
- `install.sh --check` and `agent-project-check` WARN when installed ≠ pin, and FAIL when the installed version's
  local patches aren't all applied (`openrig-apply-patches --check`).
