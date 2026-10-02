### Changed
- New rigs' CULTURE carries the operator rule: never rebase or force-push a published PR branch (no
  `gh pr update-branch --rebase`, no force-push on a PR head); refresh a PR by merging main into it. The integrator
  role and `project-sdlc.yaml` no longer call merge announcements "rebase triggers": they are refresh triggers, and the
  implementer role merges main into its PR branch after an overlapping merge instead of rebasing.
