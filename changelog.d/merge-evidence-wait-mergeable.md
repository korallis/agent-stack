### Fixed
- `agent-merge-evidence --decide` never asks Jev while GitHub reports `mergeable` UNKNOWN, which it does while recomputing
  after a push or a base change. It reads `mergeable` every 5 s for up to 90 s first. If it is still UNKNOWN, it exits 4
  ("NOT DECIDED", Jev not asked), as it does if the full read flips back to UNKNOWN. Three HOLDs on one project were
  only the recompute.
