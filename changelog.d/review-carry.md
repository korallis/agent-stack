### Added
- `agent-merge-evidence`: a review carried to a refreshed head counts toward the risky two-family rule only when the
  helper proves the carry itself. The carry is an `independent-review` status saying `carried from <sha A>`. The
  conditions are:
  1. A is an ancestor of the head.
  2. The PR's own files are byte-identical (same paths vs each merge-base, same blob shas).
  3. Everything that changed from A to the head came from the base branch.
  4. Required CI is green on the head, and the seat itself passed at A.
  At least one family must still be a fresh exact-head review. The Jev input lists each carried review as carried,
  proven or not and why.
