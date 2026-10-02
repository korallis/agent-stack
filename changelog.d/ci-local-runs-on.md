### Changed
- agent-stack's CI job runs on the local runner (label `korallis-local`, WO100) when the repo variable `CI_LOCAL` is 1,
  and on GitHub's hosted runner otherwise. A pull request from a fork always runs hosted.
