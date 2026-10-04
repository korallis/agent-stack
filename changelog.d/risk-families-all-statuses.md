### Fixed
- `agent-merge-evidence`: a risky PR's review families come from every `independent-review` status on the head, not
  just the newest. All reviewers post that context from one GitHub account, so the combined status showed only one
  family and every risky PR was held. Each seat (the description's first word, e.g. `review-kimi`) counts by its
  newest record across statuses, comments and reviews, and only if it's bound to the head. The author's seat is also read
  from `tests/`, `wp/` and `plan/` branches, not only `agent/`.
