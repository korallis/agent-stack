### Changed
- Seat `rig`: a seat's park (`queue block --on`, `queue update --state blocked --blocked-on`) must name a blocker that
  clears: a live `qitem-…`, `pr:<owner/repo>#<n>`, `check:<name>@<sha>`, `github-ci:<run>`, OpenRig's `fold:`/`auth:`,
  a human seat, `gate:owner-<decision>` (with `--wake-after` ≤ 2h, parsed as OpenRig does), or `external:<seat>:<reason>` naming a seat that
  exists and isn't the caller (with `--wake-after` ≤ 2h). Anything else is refused (exit 2) with the rule. Seats had
  parked rows on invented free-text blockers ("external:qa-scheduling") and sat idle with work waiting. The
  `~/.local/bin/rig` launcher now routes a seat's `block` and `update` through the helper too. Rows already parked are
  untouched; the operator's own shell isn't checked.
