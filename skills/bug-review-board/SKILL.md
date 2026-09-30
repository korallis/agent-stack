---
name: bug-review-board
description: Real-user bug hunt on a running web app in the Playwright MCP browser, ending in a ship YES/NO verdict. Use when QA checks a PR or a wave before merge, or when someone asks "is this ready to ship?". Files P0/P1/P2 bugs as queue rows to the lead and records the verdict as proof for the merge gate.
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
   MCP's `--secrets`. Never type, paste or echo a credential value into a tool input, a queue row, a PR or a proof. If a
   login you need is missing, ask the lead; don't guess.

## Run the pass

- Drive the real UI in the Playwright MCP browser: read the screen, click by visible names, type into labelled fields.
  One browser tab per agent.
- Cover three viewports: mobile 375 x 812, tablet 768 x 1024, desktop 1280 x 800. Start with the app's primary one
  (from the SPEC; if unclear, say which you assumed).
- Walk every acceptance criterion, then what real users get wrong: empty and invalid input, double clicks, very long
  text, back and forward, refresh mid-flow, starting over.
- Keep sessions clean. A fresh-user scenario starts with cleared cookies and storage. Use a new persona or run-tag for
  each fresh signup. Leave 30 s between repeated auth attempts, because auth providers throttle. Sign out and clear
  storage when you switch roles.
- Capture evidence at the moment of failure: a screenshot, the console errors verbatim, the URL.

## File each bug when it happens

File on FAIL, not at the end. One queue row per bug to the lead:

```bash
rig queue create --destination <lead seat> --tags bug,P1,<slice> --body-file bug.md
```

The body, every section filled:

- **Title:** the observed behaviour ("Save on /profile loses the avatar"), not the suspected fix.
- **Priority:** P0, P1 or P2 (below).
- **Impact:** who is hurt and how.
- **Expected** (from the acceptance criterion or VERIFY.md) and **Actual** (what the screen showed).
- **Steps:** exact and repeatable by a fresh agent: persona (the secret's NAME, never its value), start URL, each click
  and typed value, what to wait for.
- **Evidence:** the screenshot, attached with `rig proof add --media <file>`, and the console lines.

| Level | Meaning | Effect |
|---|---|---|
| P0 | Blocks a core flow, loses data, bypasses auth, security hole | Cannot ship. Stop the pass and tell the lead. |
| P1 | A feature is broken or wrong; a workaround exists | Blocks this PR or wave |
| P2 | Cosmetic, edge case, accessibility, console noise | Doesn't block; the lead schedules it |

Between P0 and P1, pick P0 if a user could lose data or get stuck with no way back.

## Verdict

Ship YES only when every acceptance criterion passed in the browser, no P0 or P1 is open against this PR or wave, and
each earlier bug you re-tested is fixed. Otherwise NO, with the open P0/P1 list and anything you could not run.

Record it as proof on the slice, against the exact head:

```bash
rig proof add <mission>/slices/<slice> --artifact-type qa --verdict PASS   --candidate-sha <head> --file brb.md   # YES
rig proof add <mission>/slices/<slice> --artifact-type qa --verdict BLOCKING --candidate-sha <head> --file brb.md # NO
```

`brb.md` holds the verdict line (`Ship: YES` or `Ship: NO`), the viewports and scenarios covered, and the bug row ids.
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
