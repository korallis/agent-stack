### Added
- `agent-merge-evidence`: an interim reduced-review mode (owner decision 2026-10-04, while Kimi and Grok are
  unavailable). A risky PR with the `reduced-review` label passes the review part with one fresh review from a family
  other than the author's, plus one fresh exact-head review by a seat of the author's own family that wrote none of the PR
  (not its branch seat, nor an `Author:` seat in its body). The Jev input says "reduced review: Kimi/Grok unavailable,
  owner decision 2026-10-04". Without the label the two-family rule stands.
