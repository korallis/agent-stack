### Fixed
- `agent-merge-evidence --decide` holds a risky PR before Jev is asked. It reads the risk tier of the features the PR
  title names (F-ids) from the repo's `features.json` on the base branch. A `risky` one needs two independent reviews
  from two families other than the author's (review-seat comments, GitHub reviews or the review status, on the exact
  head) and the `owner-approved` label; otherwise it exits 1 with MISSING lines. A risky PR had merged with one review
  and no label. The integrator role says so.
