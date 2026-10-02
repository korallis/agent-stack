### Changed
- `agent-reroute` tells the rig's lead once about each row it leaves unmoved: left for the lead (for example a review
  row that doesn't name its author's family), or no free seat in any family. The message names the row and the reason,
  and goes to the deputy when the lead itself can't be served. A failed send is retried on the next pass. Before, such
  rows sat silently (seen during a day of Kimi limits).
