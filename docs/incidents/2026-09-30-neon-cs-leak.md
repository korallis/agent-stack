# 2026-09-30 ~10:39Z: a Neon connection string printed into a seat transcript

## What happened
An ops seat ran `neon connection-string --no-secrets`. The installed CLI
(neon 6.3.0) has `--no-secrets` only on `projects create` and `branches create`; on `connection-string` the flag is
unknown and was silently ignored. The full owner connection string, password included, went to stdout, and so into
the seat's transcript. The role is project-level, so the production branch and every child branch shared that password.

## Recovery
The project rotated the password: production first (done and verified at the time of writing), then the child
branches and a redeploy with the new values (in progress then). A warning went into the project's runbook.

## Prevention
- `seat-bin/credguard`, in front of every seat's `neon`/`neonctl`/`vercel`/`vc` (env.sh shell functions plus seat-bin on
  the daemon's PATH):
  - credential-printing commands run only with `--output-file <path>` (written 0600, never through a symlink) or with
    stdout to /dev/null. A plain `> file` is refused too: Claude Code's Bash tool captures a command's stdout in a
    regular file that becomes the transcript, so the guard can't tell the two apart;
  - a `--no-secrets` that the installed CLI's own `--help` doesn't list for that command is refused, not passed on;
  - `vercel env ls --json` and `vercel env pull /dev/stdout` are guarded the same way;
  - arguments are read the way the CLI's parser (yargs) reads them, erring on the guarded side, and file destinations
    are checked where the CLI really writes (a link to the harness's capture file is refused).
- Rollout is verified, not assumed: `agent-credguard-check` reports each running seat. Codex runs commands with its own
  PATH, where seat-bin comes before any real CLI. Claude Code seats get the env.sh functions from the shell snapshot
  they take at launch, so they are guarded only after a relaunch at idle.
- Rule in the rig CULTURE template and docs/PROJECT-ENV.md: never print a credential; write it to a 0600 file and use
  it by name.
- test/credguard.test.js and test/credguard-check.test.js: stub CLIs and a fake /proc only, including a harness that
  captures stdout in a regular file.

## Limits
The guard covers these CLIs' own output. It can't stop a seat from printing a file's contents (`cat .env`) or running
the real binary by its full path. The CULTURE rule covers those.
