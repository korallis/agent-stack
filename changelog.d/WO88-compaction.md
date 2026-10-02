### Changed
- Seats compact earlier, the main cause of the quota burn (WO88): the average seat held 54% of a 1M window, so every
  turn re-sent about half a million tokens.
  - Claude Code seats: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 400000 for leads and architects, 200000 for every other seat
    (Claude models report 1M here, Sonnet 5.5 included). Measured with `/context`: compaction at ~367k and ~167k
    instead of ~967k.
  - Codex seats: `model_auto_compact_token_limit` 300000 for leads and architects, 200000 for every other seat, earlier
    than Codex's own default of 90% of the model's context window (Codex uses the smaller of the two).
  - Explicit values win; seats pick this up when they relaunch.
