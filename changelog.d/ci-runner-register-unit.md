### Fixed
- Local CI runners start again after the home bind (#154). systemd can't set up a privileged `ExecStartPre=+` step in
  the sandboxed unit once the runner's home is bound over the real home path (226/NAMESPACE). Registration is now its own
  unsandboxed unit, `agent-ci-runner-register@<repo>.service`, which the runner unit requires before every start.
