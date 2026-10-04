### Fixed
- `agent-merge-evidence --decide` holds a risky PR before Jev is asked. It reads the risk tier of the features the PR
  title names (F-ids) from the repo's `features.json` on the base branch. A `risky` one needs two independent reviews
  from two families other than the author's (review-seat comments, GitHub reviews or the review status, on the exact
  head) and the `owner-approved` label; otherwise it exits 1 with MISSING lines. It fails closed: in a repo that has a
  `features.json`, an unreadable file or an F-id not in it is "tier unknown" (exit 1, Jev not asked); a repo without
  one keeps "no tier". A risky PR had merged with one review
  and no label. The integrator role says so.
