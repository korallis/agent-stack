### Security
- The credential guard (Claude and Codex PreToolUse) refuses commands that print environment values: `ps` with
  `e`/`eww`/`-E`, `env` and `printenv` with no name (or `printenv` of a secret-like name), `set` with no arguments,
  `export -p`, `declare`/`typeset -x`/`-p`, and anything reading `/proc/*/environ`. A seat had printed process
  environments, API keys included, into its transcript with `ps eww`. The refusal names names-only alternatives:
  `compgen -e`, `${NAME:+x}`, and the new `agent-credguard-read-hook --env-names [PID]`, which prints a
  process's variable names only.
