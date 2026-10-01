# review.merge_gate v2: live Jev results (WO75, 2026-10-01)

Diagnosis calls only (`--caller diagnosis:wo75-merge-gate --no-cache --no-model-fallback`), never used to merge. v1 is the gate
before this change (one call per input); v2 is this rule (three calls per input). Every input carries the line
`scope (from the diff): …` that `agent-merge-evidence` now computes from the PR's diff. The gate merges on `decision=merge` in the
act band, or in review/uncertain with the QA exact-head confirm; a negative must come back `decision=hold`. Independently of Jev,
`agent-merge-evidence` refuses (in every band) a head whose required checks, review verdict or QA PASS isn't green.

| Input | Wanted | v1 (band, decision, top) | v2 runs 1-3 (band, decision, top) |
|---|---|---|---|
| the reported tests-first PR (private input + its real scope line; not committed) | merge | uncertain hold hold=0.81 merge=0.19 | uncertain merge merge=0.52 hold=0.48; uncertain merge merge=0.54 hold=0.46; uncertain merge merge=0.58 hold=0.42 |
| `positive.json` (anonymised equivalent) | merge | uncertain hold hold=0.56 merge=0.44 | act merge merge=0.89 hold=0.11; act merge merge=0.89 hold=0.11; act merge merge=0.9 hold=0.1 |
| `app-file-changed.json` | hold | uncertain hold hold=0.83 merge=0.17 | uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.98 merge=0.02 |
| `failure-at-built-step.json` | hold | uncertain hold hold=0.66 merge=0.34 | uncertain hold hold=0.87 merge=0.13; uncertain hold hold=0.85 merge=0.15; uncertain hold hold=0.87 merge=0.13 |
| `failure-not-observed.json` (QA predicted, did not run) | hold | uncertain hold hold=0.74 merge=0.26 | uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.97 merge=0.03; uncertain hold hold=0.98 merge=0.02 |
| `qa-fail.json` | hold | uncertain hold hold=0.73 merge=0.27 | uncertain hold hold=0.81 merge=0.19; uncertain hold hold=0.81 merge=0.19; uncertain hold hold=0.84 merge=0.16 |
| `qa-missing.json` | hold | uncertain hold hold=0.52 merge=0.48 | uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01 |
| `red-ci.json` | hold | uncertain hold hold=0.99 merge=0.01 | uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.99 merge=0.01 |
| `stale-ci.json` (CI of another commit) | hold | uncertain hold hold=0.67 merge=0.33 | uncertain merge merge=0.59 hold=0.41; uncertain merge merge=0.59 hold=0.41; uncertain merge merge=0.63 hold=0.37 |
| `missing-review.json` | hold | uncertain hold hold=0.94 merge=0.06 | uncertain hold hold=0.96 merge=0.04; uncertain hold hold=0.95 merge=0.05; uncertain hold hold=0.98 merge=0.02 |
| `no-failure-location.json` | hold | uncertain hold hold=0.74 merge=0.26 | uncertain hold hold=0.73 merge=0.27; uncertain hold hold=0.74 merge=0.26; uncertain hold hold=0.74 merge=0.26 |

QA's own control set (dev-qa, 18 synthetic inputs, each given the scope line the builder would compute), v2, one call each:

| Input | Wanted | v2 (band, decision, top) | |
|---|---|---|---|
| `app-file-changed` | hold | uncertain hold hold=0.98 merge=0.02 | ok |
| `build-changed` | hold | uncertain hold hold=0.98 merge=0.02 | ok |
| `failure-at-built-step` | hold | uncertain hold hold=0.86 merge=0.14 | ok |
| `inferred-failure` | hold | uncertain hold hold=0.98 merge=0.02 | ok |
| `missing-ci` | hold | uncertain hold hold=1 merge=0 | ok |
| `missing-review` | hold | uncertain hold hold=0.96 merge=0.04 | ok |
| `mixed-failures` | hold | uncertain hold hold=0.78 merge=0.22 | ok |
| `no-failure-location` | hold | uncertain hold hold=0.79 merge=0.21 | ok |
| `ordinary-failing-test` | hold | uncertain hold hold=0.99 merge=0.01 | ok |
| `ordinary-green` | merge | review merge merge=0.74 hold=0.26 | ok |
| `positive` | merge | act merge merge=0.89 hold=0.11 | ok |
| `qa-fail` | hold | uncertain hold hold=0.89 merge=0.11 | ok |
| `qa-missing` | hold | uncertain hold hold=0.99 merge=0.01 | ok |
| `red-ci` | hold | uncertain hold hold=0.99 merge=0.01 | ok |
| `schema-changed` | hold | uncertain hold hold=0.98 merge=0.02 | ok |
| `stale-ci` | hold | uncertain merge merge=0.56 hold=0.44 | WRONG |
| `tests-all-green` | merge | act merge merge=0.84 hold=0.16 | ok |
| `vague-failure` | hold | uncertain hold hold=0.83 merge=0.17 | ok |

`stale-ci` (a CI line naming another commit) still comes back merge in the uncertain band: Jev does not compare that hash with
`head`. `agent-merge-evidence` can't produce such a line (it reads the checks of the exact head) and its gate check refuses a head
without passing checks, so this case is held in code.

How the wording got here: criteria-only edits left the reported PR below the merge line; a general "failing tests are expected"
instruction let red CI, a failure at an already-built step and a missing failure location through. What separates the cases:
tests-only as a fact computed from the diff (the scope line) rather than read from prose; a failure QA actually ran and saw (a
carried run on unchanged test files counts) exactly at the step that needs the unbuilt feature; an already-built step is a defect
whatever QA's verdict says; a bare failure count names no step; a QA FAIL or no QA verdict is a blocker; and the exception never
covers CI.
