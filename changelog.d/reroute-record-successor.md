### Changed
- `agent-reroute` records the successor row each move creates. The handoff answers `{ closed, created }`, and the move's
  output and the `reroutes` ledger (new `successor` column, added in place) keep `created.qitemId`, so a rerouted chain
  can be followed from the journal.
