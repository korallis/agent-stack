---
name: verification-guide
description: Write and keep docs/VERIFY.md, the project's feature map with the exact steps and test data that prove each user-facing feature works. Use at project setup, when a new user-facing area appears, or when QA or a witness finds the map wrong. The architect owns it; QA, witnesses and the bug review board follow it.
---

# Verification guide

`docs/VERIFY.md` answers one question for an agent that has never seen the app: how do I prove this feature works the
way a user sees it? Write it for that reader, who reads it cold in the middle of a task.

## When

- At project setup, before the first wave is dispatched.
- When a slice adds a user-facing area (a new page, flow, command or API a client calls). The architect updates the
  map in the same wave, before its W witness slice runs.
- When QA, the bug review board or a witness finds a step that no longer matches the app. They send the lead a queue
  row. The architect fixes the map.

## Find the answers in the repo

Ask the owner only what the repo can't tell you.

- **Surface:** what a user touches (web UI, CLI, API, mobile). Name the primary one and list the others.
- **Run:** the repo's own dev or preview command, the port, the env it needs, and the seed data. Use the deployed URL
  when the project deploys on merge.
- **Drive:** the tool that exercises it: the Playwright MCP browser for web, a shell for a CLI, `curl` for an API.
  Network and console listings go to a file in the seat's scratch dir (`filename`), then `agent-net-summary <file>`;
  the raw listing never goes into the transcript or the proof.
- **Observe:** what proves it: what the screen shows, a response body, an exit code, a database row read back.
- **Isolate:** whether two runs can share one instance. If they can't, say so and say how to get a clean one.

## The file

```markdown
# Verifying <app>

## Baseline
- URL or command, seed data, test accounts BY NAME (from playwright.env: `ACME_ADMIN_EMAIL`, `ACME_ADMIN_PASSWORD`),
  and the one check that says the instance is worth driving (right build, healthy, logged-in page loads).

## Proof rules
- Drive the real user path, never internal setters or test-only endpoints.
- Capture the action and the resulting state, not only the final screen.
- Check side effects too: the email sent, the row written, the file saved.

## Features
### <feature>
- Sub-features: short ids, one line each.
- How a user gets there: every entry point (menu, link, deep URL, shortcut).
- Steps: `Preconditions:`, then action -> exact input -> what the user should see.
- Gotchas: what wastes a run or gives a false pass.
```

Start with the 3 to 5 features users use most. Add the rest as slices land. Keep implementation details out; name only
user paths, visible labels, test data and observable results.

## Prove the guide before you hand it over

Run it once yourself: baseline check, one feature end to end, evidence captured. A guide nobody has run is a draft.
Commit it in a PR like any other change.

## Who uses it

- QA and the bug review board take their scenarios from it.
- Witnesses walk its steps on the deployed environment.
- Reviewers check that a PR adding a user-facing area also updates it.

---
Adapted from `create-verification-skill` in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan
(v0.15.5, commit fae2c6e, 2026-09-29), MIT licence; the licence text is in `LICENSE` beside this file. Changes: a single
`docs/VERIFY.md` owned by the architect instead of a generated Cursor skill folder; tied to our QA, witness and review
steps; credentials by name only.
