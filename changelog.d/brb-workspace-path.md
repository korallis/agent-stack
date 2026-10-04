### Fixed
- `agent-merge-evidence` finds QA's bug-review-board proof in the rig workspace, not only the checkout it runs from. It
  searches `$OPENRIG_WORK_ROOT`, then `<Project>-work` beside the worktree or checkout, then `~/Projects/<repo>-work`,
  then `.`. It accepts `brb-<full or 7+ char sha>.md` and `-rN` revisions, and the highest revision wins. An
  integrator had seen a false "MISSING: no bug-review-board proof".
