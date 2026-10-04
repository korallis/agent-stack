### Fixed
- Local CI runners: `agent-ci-runner install` re-registers an idle runner whose label changed (a main lane moved), so it
  takes its new jobs at once. Idle means no job slot here and not busy on GitHub. A busy runner still changes at its next
  registration, after its job. Before, the old lane runner kept `korallis-local-main`, possibly for good.
