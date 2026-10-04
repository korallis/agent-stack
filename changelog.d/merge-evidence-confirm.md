### Added
- `agent-merge-evidence --decide --confirm <comment-url>` posts the below-bar `jev-merge` status itself. On NEEDS
  CONFIRM (a live Jev merge below the act bar, every gate green), it checks the confirm: it must be on this PR, from a
  seat of a known family other than the author's ("## <seat>" or "Reviewer: <seat>"), with "confirm <full head sha>"
  opening a line or a sentence of its own, and no failing verdict. It then posts success: "Jev merge below confidence bar
  (<request id>); <seat> confirmed at <sha>", linked to the confirm, and exits 0. It never posts on HOLD, an act-band
  pass, fallback, stubbed answers or errors. An unaccepted confirm stays exit 3 with the reasons; `--no-post` only
  verifies. Integrators had hit branch-policy blocks after hand-posting it. The integrator role text matches.
