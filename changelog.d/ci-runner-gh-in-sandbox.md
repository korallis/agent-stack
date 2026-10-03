### Fixed
- Local CI runners: jobs have `gh`, as on hosted Ubuntu. A guard that reads a PR's live labels with `gh` logged "could
  not read live labels" on a local runner and failed every labelled protected-path PR, because this host's `gh` is a mise
  install under the home the sandbox hides. The real binary is copied into `ci-runners/_shared/bin` (at install, every
  registration and `refresh-hooks`; skipped when unchanged), which is first on the unit's `PATH`.
