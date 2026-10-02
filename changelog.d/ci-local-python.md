### Fixed
- agent-stack CI on the local runner: `actions/setup-python` has no builds for its Arch Linux, so it runs only on hosted
  runners. The local runner uses the host's `python3` with pyyaml, the same as local `agent-heavy` runs.
