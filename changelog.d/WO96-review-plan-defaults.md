### Fixed
- `agent-dispatch review-plan` without `--rig` returned `reviewer: null` and said nothing; the rig now defaults to the
  caller's own, and outside a seat the plan says to pass `--rig`. A remote branch (`origin/agent/<seat>`) names the
  author's seat as `agent/<seat>` does, so the author never reviews its own branch. A `--repo` that isn't a local
  checkout (`owner/name`) is refused with a hint (WO96 pilot).
- `agent-merge-evidence` knows the Grok family (`--author-family grok`, `agent/impl-grok-*` branches, `review-grok`
  seats): a Grok author's PR is gated on another family's review, never a Grok seat's.
