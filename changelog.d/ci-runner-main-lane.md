### Added
- Local CI runners: `agent-ci-runner install <repo> --count 2 --main-lane` keeps the last runner for `main`. It registers
  with only the label `korallis-local-main`, so it never takes a PR job. A workflow sends push-to-main jobs there
  (`docs/RUNNERS.md`, *Main lane*). With one runner, post-merge `main` runs queued behind PR runs, and every merge
  waits for a green `main`. `watch` treats the repo as down while either kind of runner is down.
