### Fixed
- Local CI runners: registration failed after the per-job runner reset. The unit starts `register` inside the runner
  directory that the reset replaces, so `gh` (a mise shim) ran in a deleted working directory and mise failed with
  "No such file or directory". `register` now moves to the runners root before replacing anything, and `gh` always runs
  from the real home.
