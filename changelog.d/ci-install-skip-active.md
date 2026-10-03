### Fixed
- Local CI runners: `agent-ci-runner install` enables every runner but starts only inactive ones, as `start` does.
  `enable --now` on an active runner also started its register unit, which re-extracts the runner and wipes its home
  under a running job. Scaling a repo up or adding a main lane is now safe while jobs run.
