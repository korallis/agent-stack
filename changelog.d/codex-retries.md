### Changed
- Codex retries to the local proxy are 12/12 (`request_max_retries`, `stream_max_retries`), up from 4/5: seats gave up on
  seconds-long 429 bursts. `install.sh` keeps them at 12 or more in an existing `~/.codex/config.toml`
  (`system/codex-retries`, in place with a backup, never lowering a higher value; `--check` only reports). The
  `pool-*.config.toml` role profiles are layered on top by `codex -p` and set no provider, so they inherit it.
