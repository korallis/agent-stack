### Added
- `agent-harness-status` reads Grok (grokbuild) and Kimi quota from those CLIs, and rig-console shows it next to
  the CLIProxyAPI usage proxy.
  - OpenRig's `rig provider status` is Claude (and later Codex) only. The usage proxy parses Claude, Codex,
    Antigravity, Devin and Meta. Kimi proxy seats have null quota; there was no grokbuild path at all.
  - The new tool looks for `grok` or `grokbuild`, and `kimi`, on PATH, runs `usage --json` (then `usage`), and
    prints only percents those commands reported. Remaining % becomes used = 100 − remaining only when a remaining
    number is present. A missing CLI is `not_installed`; a CLI with no quota fields is `unavailable`. Never a
    made-up 0%.
  - rig-console caches `agent-harness-status --json` on the same 30 s clock as the proxy. Mission Control, the
    Seat Matrix and Pool & System draw a **HARNESS USAGE** panel beside the subscription pool.
  - Enable: install the Grok Build CLI from xAI (`grok` or `grokbuild` on PATH, then `grok login`) and
    `npm i -g @moonshot-ai/kimi-code` then `kimi login`. `agent-login kimi` only adds a proxy seat. Older builds
    without `usage --json` show "no reading", not a stub percent.
