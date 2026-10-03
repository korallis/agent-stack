### Fixed
- OpenRig patch 149 (0.6.3): the stuck sweep no longer raises an "unclaimed-obligation" finding for an owner decision
  row (a human destination with `human_intent` decision, or none). Those rows wait, pending and unclaimed, for the human
  by design, so each finding (one per row, to the operator, after 60 min) was noise. A human's update rows and agent rows
  are swept as before.
