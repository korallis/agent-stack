---
name: review-lenses
description: Named lenses for reviewing a PR (correctness, security and data, maintainability, UX and journey, performance) and the way to sort findings into act on, consider, noted and dismissed. Use for every cross-family review; apply the lenses the diff touches.
---

# Review lenses

A review from the other model family is the merge gate's main input. It finds what the author's family misses because
it looks from a different angle, not because it plays a role. Apply the lenses the diff touches, and say which ones you
applied and which you skipped.

## Start with the intent

Write one paragraph: what the PR is meant to do, from the slice SPEC, the PR description and the commits. If you can't
tell, ask the author before reviewing. Every finding is judged against that intent.

## The lenses

**Correctness.** Does the code do what the intent says?
- Edge cases: empty input, nulls, boundaries, very large values, concurrent access.
- Errors: caught, passed on, or silently swallowed?
- Running twice, or after a crash halfway: is the result still right?
- When you suspect a bug, trace the call chain that triggers it. Don't only say "this could be null".
- Is it fixing the cause or hiding a symptom (a guard that masks a broken invariant, a retry that hides a broken
  contract, a cast that silences a type error)?

**Security and data.** For each finding, trace the input path.
- User input reaching SQL, a shell, `eval` or HTML without escaping.
- New endpoints or pages without the right auth check.
- Secrets in code, logs, errors or client bundles.
- Migrations: destructive, locking, not backward compatible with the code still running (projects that deploy on merge
  need ship-safe migrations).
- Personal data copied where it shouldn't be.

**Maintainability.**
- Could it be simpler without losing correctness? Push for the restructuring that deletes code, not one that only moves
  it.
- New special cases scattered through unrelated code; logic in the wrong layer; a helper that duplicates an existing
  one.
- An abstraction with one caller, options nobody uses yet, dead code, an old path kept alive after its callers moved.
- A file pushed past about 1000 lines without a strong reason.
- Tests that check behaviour rather than implementation; a bug fix without a test for the bug.

**UX and journey.** For anything a user sees.
- Does the journey in `docs/VERIFY.md` and the acceptance tests still work end to end?
- Visible labels, error messages next to the field, focus order, empty and loading states, mobile width.
- Copy that says something untrue.

**Performance.**
- N+1 queries, missing indexes on new filters, unbounded lists or loops, work repeated per request that could run once.
- Anything on a hot path that now blocks: network calls, sync file access.
- Only report what you can point at. No speculative micro-optimisation.

## Sort every finding

- **Act on:** a real problem for correctness, security, data or maintainability. It blocks the PR.
- **Consider:** a real point, but it may not be worth the cost now. The author decides and says why.
- **Noted:** true but not actionable at this stage.
- **Dismissed:** wrong, or missing context. Say why in one line.

Each finding gives the lens, `file:line`, what goes wrong, and the fix or the question.

## Output

Post on the PR: the intent paragraph, the lenses applied and skipped, the findings grouped as above, and a verdict (any
"act on" item means changes requested). Put the same verdict in the `independent-review` status description, and set
the status's `target_url` to your review comment's URL: the merge gate trusts only the report the status links to. Write it
with the `unslop` skill. If the diff touches shared code, migrations, env or jobs, check that the PR carries a
`blast-radius` result, or run one.

---
Adapted from the review rubric, code-quality lens and lead-judgment buckets of `interrogate` in
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (v0.15.5, commit fae2c6e, 2026-09-29), MIT
licence; the licence text is in `LICENSE` beside this file. Changes: only the review panel. No model table, no subagent
spawning, and no auto-applied fixes. Our reviewer seat of the other model family applies the lenses and posts the
result on the PR.
