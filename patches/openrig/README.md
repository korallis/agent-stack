# Local OpenRig patches

Fixes we run before upstream releases them. `bin/openrig-upgrade` calls `bin/openrig-apply-patches` after every
install. That script applies `<version>/*.patch` for the installed version, and each patch applies whole or not at
all. A missing or failed patch gets a logger + desktop warning, and OpenRig keeps running unpatched.

Each patch is a `-p1` unified diff against the published `@openrig/cli@<version>` package root (`dist/`,
`daemon/dist/`), one per upstream issue.

Patches exist for 0.5.17, 0.6.0 and 0.6.1 (134 to 139 are 0.6.1 only).

| Patch | Upstream | Fix | Drop it when |
|---|---|---|---|
| `131-canonical-local-sender` | issue #131, PR #135 (merged 2026-09-29 as a09388aa, after v0.6.1) | The daemon strips its own `@<selfHostId>` from a sender, so a claim under load no longer fails `claim_destination_mismatch` | at the first release that contains PR #135 |
| `132-project-scoped-proof` | issue #132, PR #136 (open) | `rig proof show/judge` accept `--project <id>` or `<id>:<scope>`, resolved through `workspace.yaml` | at the first release that contains PR #136 |
| `133-unclaimed-human-routes-to-source` | 0.6.1 only; fix on korallis/openrig `local-patch-0.6.1` 78cf5b5a (not yet upstream) | The stuck sweep sends an "unclaimed-obligation" finding for a row addressed to a human (`*@external` or a human seat) to the row's source seat if it is a live managed seat, else its orchestrator, else `operator-agent@kernel`, never the human; one unroutable finding no longer aborts the sweep | at the first release that contains an upstream fix |
| `134-guard-target-binding-first` | 0.6.1 regression, fix on korallis/openrig `local-patch-0.6.1` b9e88657 (not yet upstream) | `resolveGuardTarget` prefers the node whose binding (tmux session or pane) matches, so unbound nodes of ARCHIVED same-name rigs no longer make live seats ambiguous ("Cannot establish managed input target impl-codex-1@hc") | at the first release that contains an upstream fix |
| `135-codex-idle-composer` | 0.6.1 only; fix on korallis/openrig `local-patch-0.6.1` 3c747986 (not yet upstream) | Idle Codex 0.158 seats read activity "unknown" once their last hook is 5 min old: the pane classifier now recognises the idle composer (dim placeholder or empty `›`) through an ANSI capture, only when no mid-work pattern is present | at the first release that recognises the Codex >= 0.158 idle composer |
| `136-poll-cadence` | 0.6.1 only; fix on korallis/openrig `local-patch-0.6.1` 9674d254 (not yet upstream; issue draft in docs/incidents/2026-09-29-daemon-stall.md) | The structural activity sweep runs every 5s, not 1s (a cached verdict stays current for 25s, still 5 sweeps). The seat identity sweep runs every 15s, not 5s, and never overlaps itself. Each sweep spawns tmux/ps per seat, and on ~90 seats the old cadence saturated the daemon's event loop. Applies after 135. A live install hot-patched by hand must first get the two `*.pre-interval` backups back (see the incident doc) | at the first release that throttles or batches these sweeps |
| `137-proof-add-binary-file` | 0.6.1 only; fix on korallis/openrig `local-patch-0.6.1` c31d42f1 (upstream issue mvschwarz/openrig#170) | `rig proof add --file` read any file as UTF-8 and wrote it back, under a C1 header, to `proof/<the file's own name>`, so `--file proof/shot.png` corrupted the screenshot in place. Now: a non-text `--file` (binary extension, NUL byte, invalid UTF-8) is refused and pointed at `--media`; the artifact name must end in `.md` (`--file` defaults to `<stem>.md`); an existing artifact is replaced only with `--replace` (by rename, never writing through a hardlink or symlink), and never the `--file` source itself (device+inode). Applies after 132 (same file) | at the first release that stops `proof add` from writing a binary `--file` back |
| `138-seat-lookup-prefer-live-rig` | 0.6.1 only; fix on korallis/openrig `local-patch-0.6.1` f930c450 (not yet upstream) | A seat named `<member>@<rig>` matched nodes in ARCHIVED rigs of the same name too, so `rig seat handover impl-astra@hc` failed "matched multiple nodes" once older `hc` generations were archived. Seat lookups (seat-lifecycle and seat-status) now prefer the live rigs of that name; archived ones count only when no live rig has the name. Same bug class as 134 | at the first release whose seat lookup ignores archived same-name rigs |
| `139-batch-seat-tmux-reads` | 0.6.1 only; fix on korallis/openrig `local-patch-0.6.1` f23494a2 (not yet upstream; extends mvschwarz/openrig#161, draft in the PR) | The 1 Hz seat-activity sweep spawned one `tmux display-message` per seat (~85/s, 51.7% of daemon CPU), and the identity sweep a pid + command read per seat. Each sweep now reads all seats with ONE tmux call (`list-windows -a` / `list-panes -a`), per-seat only on a miss. Cadence, debounce and arbitration are unchanged. Applies after 136 (same file) | at the first release that batches these reads |

(Issues and PRs are in mvschwarz/openrig. To check a release: `git merge-base --is-ancestor <merge-sha> v<version>` in an openrig clone.)

Check what is applied: `grep -c canonicalSenderSession ~/.local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/daemon/dist/routes/require-sender-identity.js`
(non-zero = #131 is in). Undo: `patch -p1 -R -d <package> < <patch>`.

## Regenerating for a new version

1. Check out the release tag in a korallis/openrig clone. Cherry-pick the fix commits and run `bash scripts/build-package.sh`.
2. `npm pack @openrig/cli@<version>` and unpack it. Every packaged `.js` file must be byte-identical except the fix
   files and `build-info.js`. If anything else differs, the build does not reproduce the release, so stop.
3. `diff -u --label a/<path> --label b/<path> <published> <built>` for each fix file, grouped per issue.

When a release contains a fix, delete that patch for that version and newer ones. Don't carry it forward.
