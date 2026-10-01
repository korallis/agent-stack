# review.merge_gate v2: live Jev results (WO75, 2026-10-01)

Diagnosis calls only (`--caller diagnosis:wo75-merge-gate --no-cache --no-model-fallback`), never used to merge. v1 is the gate
before this change (one call per input); v2 is this rule (three calls per input). Every input carries the line
`scope (from the diff): …` that `agent-merge-evidence` now computes from the PR's diff. The gate merges on `decision=merge` in the
act band, or in review/uncertain with the QA exact-head confirm; a negative must come back `decision=hold`. Independently of Jev,
`agent-merge-evidence` refuses (in every band) a head whose required checks, review verdict or QA PASS isn't green.

| Input | Wanted | v1 (band, decision, top) | v2 runs 1-3 (band, decision, top) | Outcome |
|---|---|---|---|---|
| the reported tests-first PR (private input + its real scope line; not committed) | merge | uncertain hold hold=0.81 merge=0.19 | uncertain merge merge=0.55 hold=0.45; uncertain merge merge=0.59 hold=0.41; uncertain merge merge=0.59 hold=0.41 | Jev: merge |
| `positive.json` (anonymised equivalent) | merge | uncertain hold hold=0.56 merge=0.44 | act merge merge=0.86 hold=0.14; act merge merge=0.9 hold=0.1; act merge merge=0.91 hold=0.09 | Jev: merge |
| `app-file-changed.json` | hold | uncertain hold hold=0.83 merge=0.17 | uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01 | Jev: hold |
| `failure-at-built-step.json` | hold | uncertain hold hold=0.66 merge=0.34 | uncertain hold hold=0.88 merge=0.12; uncertain hold hold=0.88 merge=0.12; uncertain hold hold=0.86 merge=0.14 | Jev: hold |
| `failure-not-observed.json` (QA predicted, did not run) | hold | uncertain hold hold=0.74 merge=0.26 | uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.98 merge=0.02 | Jev: hold |
| `qa-fail.json` | hold | uncertain hold hold=0.73 merge=0.27 | uncertain hold hold=0.79 merge=0.21; uncertain hold hold=0.78 merge=0.22; uncertain hold hold=0.84 merge=0.16 | Jev: hold |
| `qa-missing.json` | hold | uncertain hold hold=0.52 merge=0.48 | uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01 | Jev: hold |
| `red-ci.json` | hold | uncertain hold hold=0.99 merge=0.01 | uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01 | Jev: hold |
| `missing-review.json` | hold | uncertain hold hold=0.94 merge=0.06 | uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.96 merge=0.04 | Jev: hold |
| `no-failure-location.json` | hold | uncertain hold hold=0.74 merge=0.26 | uncertain hold hold=0.73 merge=0.27; uncertain hold hold=0.76 merge=0.24; uncertain hold hold=0.72 merge=0.28 | Jev: hold |
| `stale-ci.json` (CI of another commit) | hold | uncertain hold hold=0.67 merge=0.33 | uncertain merge merge=0.63 hold=0.37; uncertain merge merge=0.65 hold=0.35; uncertain merge merge=0.58 hold=0.42 | refused in code: the builder reads the exact head's checks; `gateProblems` needs them passing |
| positive with `scope (from the diff): unknown` (QA) | hold | - - - | uncertain merge merge=0.64 hold=0.36; uncertain merge merge=0.56 hold=0.44; uncertain merge merge=0.57 hold=0.43 | refused in code: `gateProblems` fails closed on an unknown scope |
| positive without a scope line (QA) | hold | - - - | act merge merge=0.88 hold=0.12; act merge merge=0.87 hold=0.13; act merge merge=0.92 hold=0.08 | refused in code: `gateProblems` fails closed on a missing scope line |

QA's own control set (dev-qa, 18 synthetic inputs, each given the scope line the builder would compute), one call each on the v2 wording just before the 'says unknown' clause was added:

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

Split of responsibilities: Jev judges what the evidence says (what QA ran and saw, at which step, whether it is a
built step, whether QA passed). The facts that code can establish are enforced in code in every band, before Jev's answer
counts: required checks passing on the exact head, the review verdict, a QA PASS for the head, and the diff's scope line
(present and computed). Jev still answers merge on a hand-made stale-CI line, an unknown scope and a missing scope line; the
builder can't produce the first and the gate refuses all three.

How the wording got here: criteria-only edits left the reported PR below the merge line; a general "failing tests are expected"
instruction let red CI, a failure at an already-built step and a missing failure location through. What separates the cases:
tests-only as a fact computed from the diff (the scope line) rather than read from prose; a failure QA actually ran and saw (a
carried run on unchanged test files counts) exactly at the step that needs the unbuilt feature; an already-built step is a defect
whatever QA's verdict says; a bare failure count names no step; a QA FAIL or no QA verdict is a blocker; the exception never
covers CI.

## v3 (WO79): neutral scope wording

Since #80 every ordinary PR's change carried `scope (from the diff): NOT tests-only, …`, and the capitalised NOT read as a defect:
ordinary merges drifted to HOLD. v3 states it neutrally (`code change, N non-test path(s): …`); the decisive negative is a separate
`scope check:` line, added only when the change or review calls the PR tests-only but the diff changes code.

Ordinary-code PRs (saved gate inputs of merged agent-stack PRs, real file lists; 2 calls each). `none` and `before` on the v2
catalog, `after` on v3:

| PR | no scope line | v2 wording (`NOT tests-only`) | v3 wording (`code change`) |
|---|---|---|---|
| #74 | uncertain merge merge=0.55 hold=0.45; uncertain merge merge=0.57 hold=0.43 | uncertain hold hold=0.68 merge=0.32; uncertain hold hold=0.72 merge=0.28 | uncertain merge merge=0.64 hold=0.36; uncertain merge merge=0.55 hold=0.45 |
| #76 | review merge merge=0.78 hold=0.22; review merge merge=0.76 hold=0.24 | uncertain merge merge=0.64 hold=0.36; uncertain merge merge=0.64 hold=0.36 | act merge merge=0.85 hold=0.15; act merge merge=0.87 hold=0.13 |
| #77 | review merge merge=0.76 hold=0.24; review merge merge=0.78 hold=0.22 | uncertain merge merge=0.52 hold=0.48; uncertain merge merge=0.64 hold=0.36 | act merge merge=0.84 hold=0.16; act merge merge=0.82 hold=0.18 |
| #78 | uncertain merge merge=0.57 hold=0.43; uncertain merge merge=0.66 hold=0.34 | uncertain hold hold=0.6 merge=0.4; uncertain hold hold=0.62 merge=0.38 | review merge merge=0.74 hold=0.26; review merge merge=0.76 hold=0.24 |
| #79 | uncertain merge merge=0.68 hold=0.32; uncertain merge merge=0.69 hold=0.31 | uncertain hold hold=0.6 merge=0.4; uncertain hold hold=0.59 merge=0.41 | review merge merge=0.75 hold=0.25; review merge merge=0.78 hold=0.22 |
| #82 | uncertain hold hold=0.51 merge=0.49; uncertain hold hold=0.52 merge=0.48 | uncertain hold hold=0.71 merge=0.29; uncertain hold hold=0.69 merge=0.31 | uncertain merge merge=0.64 hold=0.36; uncertain merge merge=0.67 hold=0.33 |

The tests-first set on v3 (3 calls each):

| Input | Wanted | v3 runs 1-3 (band, decision, top) |
|---|---|---|
| the reported tests-first PR (private) | merge | uncertain merge merge=0.62 hold=0.38; uncertain merge merge=0.59 hold=0.41; review merge merge=0.71 hold=0.29 |
| `positive.json` | merge | act merge merge=0.91 hold=0.09; act merge merge=0.91 hold=0.09; act merge merge=0.9 hold=0.1 |
| `claimed-tests-only-code-change.json` (WO79) | hold | uncertain hold hold=0.75 merge=0.25; uncertain hold hold=0.72 merge=0.28; uncertain hold hold=0.71 merge=0.29 |
| `app-file-changed.json` | hold | uncertain hold hold=0.97 merge=0.03; uncertain hold hold=0.97 merge=0.03; uncertain hold hold=0.97 merge=0.03 |
| `failure-at-built-step.json` | hold | uncertain hold hold=0.84 merge=0.16; uncertain hold hold=0.88 merge=0.12; uncertain hold hold=0.85 merge=0.15 |
| `failure-not-observed.json` | hold | uncertain hold hold=0.97 merge=0.03; uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.98 merge=0.02 |
| `qa-fail.json` | hold | uncertain hold hold=0.81 merge=0.19; uncertain hold hold=0.83 merge=0.17; uncertain hold hold=0.77 merge=0.23 |
| `qa-missing.json` | hold | uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01 |
| `red-ci.json` | hold | uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.99 merge=0.01 |
| `missing-review.json` | hold | uncertain hold hold=0.98 merge=0.02; uncertain hold hold=0.99 merge=0.01; uncertain hold hold=0.98 merge=0.02 |
| `no-failure-location.json` | hold | uncertain hold hold=0.78 merge=0.22; uncertain hold hold=0.8 merge=0.2; uncertain hold hold=0.81 merge=0.19 |
| `stale-ci.json` | hold (held in code) | uncertain merge merge=0.59 hold=0.41; uncertain merge merge=0.67 hold=0.33; uncertain merge merge=0.55 hold=0.45 |
| unknown scope (QA) | hold (held in code) | uncertain merge merge=0.58 hold=0.42; uncertain merge merge=0.6 hold=0.4; uncertain merge merge=0.59 hold=0.41 |
| no scope line (QA) | hold (held in code) | act merge merge=0.88 hold=0.12; act merge merge=0.89 hold=0.11; act merge merge=0.91 hold=0.09 |
