### Added
- Daemon lifecycle belongs to the operator. The `rig` launcher runs `rig-lifecycle-guard` before any command naming
  `up` or `daemon`; it refuses `rig up` and `rig daemon start|stop|restart` from a seat other than the operator's (exit
  3, with "wait 30 s and retry; tell the operator if it stays down for 2 minutes"). On 2026-10-02 a seat followed
  OpenRig's "run 'rig daemon start'" advice during the operator's daemon cycle and started a second daemon outside
  `openrig.service`. OpenRig patch 146 changes that advice for seats, and the template CULTURE carries the rule.
