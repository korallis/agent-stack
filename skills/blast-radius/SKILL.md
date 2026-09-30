---
name: blast-radius
description: Before review sign-off and before merge, find what a diff could break OUTSIDE the edited files, and prove the one fact that makes it safe by running real code or a query. Use for "what could this break", for any PR touching shared code, SQL, migrations, env or jobs, and for small diffs you don't trust. The result goes in the PR.
---

# Blast radius

Listing callers is not the job; `rg` does that in a second. The job is the breakage a search won't show you.

## When

- The reviewer runs it before signing off a PR that touches shared code, SQL or queries, migrations, env or config,
  background jobs, a public API or a data format.
- The integrator checks that the PR carries it before the merge gate. For risky-tier PRs it is required.

## Steps

1. **Read the change.** The diff, the symbols it adds, changes and deletes, and what the code now does differently,
   including what the diff doesn't spell out.
2. **Find the one fact it is safe because of.** Most risky-looking changes are safe because of one fact, like "this
   migration only adds a nullable column" or "this helper is only called from the admin page". If that fact holds, most
   risks go away at once. Spend your time here.
3. **Look where search stops.** A database column read by another service or a report. JSON that a client or a stored
   job parses. An env var another deploy target sets differently. A cron job or queue consumer that runs later. A
   library's pinned version or local patch. Code three calls downstream.
4. **Rate each risk.** How it breaks, the real `file:line`, how likely, how bad, and how to check. Keep confirmed risks
   separate from the ones you checked and cleared. A search that finds nothing is an answer; say what you searched.
   Never invent a caller or an API.
5. **Prove the one fact.** Write a small script, test or read-only query that exercises the real code or data, run it,
   and paste the output. Queries go against the development database only (`.env.local`), never production.

## How sure you are

Say how far the safety fact got:

1. You said so. This proves nothing.
2. You pointed at the line (`file:line`, or the library's own source).
3. You walked the failure case step by step and showed it can't happen.
4. You ran code that calls the real function and fails loudly if you are wrong.
5. You reproduced it in the running app.

Aim for 4. If you stop earlier, write "unproven" next to the fact.

## What goes in the PR

A `## Blast radius` comment or section:

- **What changed**, including the part that isn't obvious.
- **Safe because:** the one fact, the level it reached, and the proof output.
- **Risks:** each with how it breaks, `file:line`, likelihood, cost and how to check.
- **Cleared:** what you checked and why it is fine.
- **Before merge:** the cheapest test or repro that would catch the real bug.

Write it with the `unslop` skill. No secrets or production data in the comment.

---
Adapted from `blast-radius` in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (v0.15.5,
commit fae2c6e, 2026-09-29), MIT licence; the licence text is in `LICENSE` beside this file. Changes: tied to our
reviewer and integrator steps, the result posted on the PR, queries limited to the development database; references
to pstack's `how`, `why` and `arena` skills removed.
