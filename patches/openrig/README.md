# Local OpenRig patches

Fixes we run before upstream releases them. `bin/openrig-upgrade` calls `bin/openrig-apply-patches` after every
install. That script applies `<version>/*.patch` for the installed version, and each patch applies whole or not at
all. A missing or failed patch gets a logger + desktop warning, and OpenRig keeps running unpatched.

Each patch is a `-p1` unified diff against the published `@openrig/cli@<version>` package root (`dist/`,
`daemon/dist/`), one per upstream issue.

| Patch | Upstream | Fix |
|---|---|---|
| `131-canonical-local-sender` | mvschwarz/openrig#131 | The daemon strips its own `@<selfHostId>` from a sender, so a claim under load no longer fails `claim_destination_mismatch` |
| `132-project-scoped-proof` | mvschwarz/openrig#132 | `rig proof show/judge` accept `--project <id>` or `<id>:<scope>`, resolved through `workspace.yaml` |

Check what is applied: `grep -c canonicalSenderSession ~/.local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/daemon/dist/routes/require-sender-identity.js`
(non-zero = #131 is in). Undo: `patch -p1 -R -d <package> < <patch>`.

## Regenerating for a new version

1. Check out the release tag in a korallis/openrig clone. Cherry-pick the fix commits and run `bash scripts/build-package.sh`.
2. `npm pack @openrig/cli@<version>` and unpack it. Every packaged `.js` file must be byte-identical except the fix
   files and `build-info.js`. If anything else differs, the build does not reproduce the release, so stop.
3. `diff -u --label a/<path> --label b/<path> <published> <built>` for each fix file, grouped per issue.

When a release contains a fix, delete that patch for that version and newer ones. Don't carry it forward.
