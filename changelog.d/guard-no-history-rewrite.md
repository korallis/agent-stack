### Security
- Seat guard: the PreToolUse hook every Claude and Codex seat runs also refuses rewriting published history. That
  covers `git push --force`, `-f` in any short-option cluster, `--force-with-lease[=...]` and a `+refspec`, plus
  `gh pr update-branch --rebase` / `-r`, including inside `bash -c`, `env` and `git -C`/`-c`. The denial points to
  `gh pr update-branch` (merge) or `git merge origin/main`, and fix-up commits. A seat had rebased a published PR
  despite the CULTURE rule.
