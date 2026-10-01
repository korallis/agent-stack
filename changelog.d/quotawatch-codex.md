### Fixed
- `cliproxy-quotawatch` no longer raises false Codex alerts. It read Codex's quota windows by position. Since Codex
  moved its weekly window to "primary" and dropped the 5-hour one, every Codex account raised "at 100% of its
  5-hour window", and a critical "every codex account ... will stall soon" every 3 hours, while the accounts were
  working on credits.
  - Codex windows are read by their reported length (a 0-minute window is not a limit; without lengths, by position as
    before), and the routing log now keeps each window's length and the unlimited-credits flag.
  - An account that has used a window but has credits is not a stall: one low-urgency note per provider a day. The
    provider-wide critical needs every account past the threshold with no credits to carry on; a used-up week with no
    credits is still critical.
