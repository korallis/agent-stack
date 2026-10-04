### Fixed
- `agent-ci-runner netguard-install` writes the CI slice anchor's user unit itself: it runs before `install.sh --apply`,
  which had been the only place that wrote it, so the install stopped at "unit not found". `register` also refuses a
  runner whose unit isn't in `agent-heavy-ci.slice` yet (fail closed), and RUNNERS.md gives the install order.
