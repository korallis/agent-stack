# review.merge_gate v2: live Jev results (WO75, 2026-10-01)

Diagnosis calls only (`--caller diagnosis:wo75-merge-gate --no-cache --no-model-fallback`), never used to merge. v1 is the
gate before this change, one call per input; v2 is this rule, three calls per input. The gate merges on `decision=merge` in
the act band, or in review/uncertain with the QA exact-head confirm; a negative must come back `decision=hold`. Red CI and a
missing review are also refused in code before and after Jev.

| Input | Wanted | v1 (band, decision, top) | v2 runs 1-3 (band, decision, top) |
|---|---|---|---|
| the reported tests-first PR (private input; not committed) | merge | uncertain hold hold=0.81 merge=0.19 | review merge merge=0.74 hold=0.26; review merge merge=0.72 hold=0.28; review merge merge=0.75 hold=0.25 |
| `positive.json` (anonymised equivalent) | merge | uncertain hold hold=0.56 merge=0.44 | act merge merge=0.97 hold=0.03; act merge merge=0.97 hold=0.03; act merge merge=0.98 hold=0.02 |
| `app-file-changed.json` | hold | uncertain hold hold=0.83 merge=0.17 | uncertain hold hold=0.97 merge=0.03; uncertain hold hold=0.97 merge=0.03; uncertain hold hold=0.98 merge=0.02 |
| `failure-at-built-step.json` | hold | uncertain hold hold=0.66 merge=0.34 | uncertain hold hold=0.82 merge=0.18; uncertain hold hold=0.79 merge=0.21; uncertain hold hold=0.79 merge=0.21 |
| `red-ci.json` | hold | uncertain hold hold=0.99 merge=0.01 | uncertain hold hold=1 merge=0; uncertain hold hold=1 merge=0; uncertain hold hold=0.99 merge=0.01 |
| `missing-review.json` | hold | uncertain hold hold=0.94 merge=0.06 | uncertain hold hold=0.89 merge=0.11; uncertain hold hold=0.89 merge=0.11; uncertain hold hold=0.9 merge=0.1 |
| `no-failure-location.json` | hold | uncertain hold hold=0.74 merge=0.26 | uncertain hold hold=0.71 merge=0.29; uncertain hold hold=0.66 merge=0.34; uncertain hold hold=0.63 merge=0.37 |

Wordings tried on the way (same inputs): criteria-only edits left the reported PR below the merge line; a general
"failing tests are expected" instruction let red CI, a failure at an already-built step and a missing failure location
through. What separates them is stating, in the instructions, what tests-only means, that only a failure at the step
needing the unbuilt feature is expected (an already-built step is a defect whatever QA's verdict says), that a bare
failure count names no step, and that the exception never covers CI.
