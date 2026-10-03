### Added
- `agent-ci-runner install <repo> --count N` runs several local runners for one repo (instances `<repo>_r<N>`, each with
  its own unit, GitHub runner name and job slot), so a repo's parallel jobs (browser shards) can run side by side under
  the global job cap. A lower `--count` removes the extra runners; `stop`, `start` and `remove` cover all of a repo's
  runners, and the watch timer keeps `CI_LOCAL` while any of them is up.
