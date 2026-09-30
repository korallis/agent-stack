---
name: bug-review-board
description: Real-user bug hunt on the running app (the Playwright MCP browser for a web app, the public command or HTTP API for CLI and API work), ending in a ship YES/NO verdict. Use when QA checks a PR or a wave before merge, or when someone asks "is this ready to ship?". Files P0/P1/P2 bugs as queue rows to the lead and records the verdict as proof for the merge gate.
---

# Bug review board (BRB)

Use the app the way a careful, slightly unforgiving customer would, and write down everything that goes wrong. You do
not read the source to decide whether something works. The user never sees the source.

## Before you start

1. Scope: which PR or wave, which head commit, which deployed or local URL.
2. Read what the app promises: `docs/VERIFY.md` (the feature map, see the `verification-guide` skill), the slice SPEC
   and acceptance criteria, `docs/PLAN.md`. Read what just changed: the PR description and diff summary.
3. Read the open bugs for this area (queue rows tagged `bug`). Re-test those first: regressions are the most valuable
   finds.
4. Test accounts come from `~/.config/agent-stack/secrets/playwright.env` and are typed BY NAME through the Playwright
   MCP's `--secrets`. For CLI and API work, the app or your command reads credentials from env by name. Never type,
   paste or echo a credential value into a tool input, a queue row, a PR or a proof. If a login you need is missing,
   ask the lead; don't guess.

## Run the pass

Use the interface a user of this feature uses, with the steps in `docs/VERIFY.md`:

- **Web:** the real UI in the Playwright MCP browser. Read the screen, click by visible names, type into labelled
  fields. One browser tab per agent. Cover three viewports: mobile 375 x 812, tablet 768 x 1024, desktop 1280 x 800,
  starting with the app's primary one (from the SPEC; if unclear, say which you assumed). Keep sessions clean: a
  fresh-user scenario starts with cleared cookies and storage, each fresh signup gets a new persona or run-tag, repeated
  auth attempts are 30 s apart, and you sign out and clear storage when you switch roles.
- **CLI:** the documented command, as a user runs it, from a clean state.
- **API:** the public HTTP endpoints a client calls, not internal functions or test-only routes.

Walk every acceptance criterion, then what real users get wrong: empty and invalid input, repeated actions, very long
input, interruption halfway, starting over. Capture evidence at the moment of failure:

- web: a screenshot, the console errors verbatim, the URL;
- CLI: the command, stdout, stderr and exit code;
- API: the request (method, path, body, never a credential), the status and the response body.

Never make up browser evidence for work that has no UI, and never add UI work just to test through it.

## File each bug when it happens

File on FAIL, not at the end. One queue row per bug to the lead:

```bash
rig queue create --destination <lead seat> --mission <mission> --slice <slice> --tags bug,P1 --body-file bug.md
```

The body, every section filled:

- **Title:** the observed behaviour ("Save on /profile loses the avatar"), not the suspected fix.
- **Priority:** P0, P1 or P2 (below).
- **Impact:** who is hurt and how.
- **Expected** (from the acceptance criterion or VERIFY.md) and **Actual** (what the screen showed).
- **Steps:** exact and repeatable by a fresh agent: persona (the secret's NAME, never its value), start URL, each click
  and typed value, what to wait for.
- **Evidence:** as captured above. A screenshot goes into the slice's `proof/` dir, attached with `rig proof add
  --media <file>` next to a text note.

| Level | Meaning | Effect |
|---|---|---|
| P0 | Blocks a core flow, loses data, bypasses auth, security hole | Cannot ship. Stop the pass and tell the lead. |
| P1 | A feature is broken or wrong; a workaround exists | Blocks this PR or wave |
| P2 | Cosmetic, edge case, accessibility, console noise | Doesn't block; the lead schedules it |

Between P0 and P1, pick P0 if a user could lose data or get stuck with no way back.

## Verdict

Ship YES only when every acceptance criterion passed through its user interface (browser, command or HTTP, as above),
no P0 or P1 is open against this PR or wave, and each earlier bug you re-tested is fixed. Otherwise NO, with the open
P0/P1 list and every criterion you could not run. A criterion you could not reach (a missing login, a broken
environment) is "not run", which means NO. It is not a product bug, so say what blocked it instead of filing one.

Record it as proof on the slice, against the exact head. In a seat, `OPENRIG_WORK_ROOT` points `rig proof add` at the
project's missions:

```bash
rig proof add <mission>/slices/<slice> --artifact-type qa --verdict PASS --candidate-sha <head> \
  --money-evidence "Ship: YES, <n> criteria passed, no open P0/P1" --file brb.md       # YES
rig proof add <mission>/slices/<slice> --artifact-type qa --verdict BLOCKING --candidate-sha <head> \
  --money-evidence "Ship: NO, <open P0/P1 or not-run criteria>" --file brb.md          # NO
rig proof show <project-id>:<mission>/slices/<slice>                                   # read it back (catalog id)
```

`brb.md` holds the verdict line (`Ship: YES` or `Ship: NO`), the interfaces and scenarios covered (viewports for web),
and the bug row ids.
Post the same verdict line on the PR. The integrator puts it in the `review` input of the Jev merge gate. A NO blocks the
merge like a failing check.

## Never

- Mark a scenario passed from reading code.
- Fix product code during the pass. Test, file, hand off.
- Change the SPEC or VERIFY.md to match buggy behaviour. File the bug.
- Merge or close bugs you think are duplicates. Say so in the row; the lead decides.

---
Adapted from `running-bug-review-board` in [rayfernando-skills](https://github.com/RayFernando1337/rayfernando-skills)
by Ray Fernando (commit 952eaaa, 2026-07-19), Apache License 2.0; the licence text is in `LICENSE` beside this file.
Changes: rewritten for OpenRig seats. Bugs are filed as queue rows and the verdict is recorded with `rig proof add`,
instead of local bug files, tracker sync and an HTML report. Credentials are typed by name through the Playwright MCP.
Dropped: iOS, desktop and Computer Use playbooks, the interactive triage session, parallel shards, and the bundled
scripts.
