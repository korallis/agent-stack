### Fixed
- `agent-merge-evidence`: the risk tier comes from the F-ids in the PR's title or body, not only the title. A risky
  feature's PR named it only in its body, so its tier was never read and the gate passed before the `owner-approved`
  label existed. Every F-id named counts, and the highest tier wins.
