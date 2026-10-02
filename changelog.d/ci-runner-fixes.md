### Fixed
- `agent-ci-runner`: the runner unit can be enabled (`[Install] WantedBy=default.target`), and its registration step finds
  `gh` under the unit's minimal PATH (`~/.local/bin` and the mise shims, `AGENT_CI_TOOL_PATH`). Both stopped the first
  live install (WO100); `CI_LOCAL` was never set, so no job was affected.
