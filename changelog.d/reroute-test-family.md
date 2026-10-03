### Fixed
- `agent-reroute` keeps a test-author row off its slice's implementer family. It reads `Implementer: <seat> (<family>)` or the
  `implementer:` / `implementer-family:` tags; a test row without one is left for the lead, who is told once. Cooling
  Kimi test rows for a Grok-built slice had been moved to Grok test seats, which refused them.
