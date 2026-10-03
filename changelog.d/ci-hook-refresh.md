### Fixed
- Local CI runners: a job gate (`ci-runner-hook`) change reaches the runners without a manual `install`. Every
  registration (before each job) and `install.sh --apply` refresh `ci-runners/_shared` (new `agent-ci-runner
  refresh-hooks`). Only `install` copied it before, so the merged fork refusal was not live until a runner was
  re-installed. The copy is a rename, never an in-place write, so a job's bash still reading the old hook is never
  handed a partly written file.
