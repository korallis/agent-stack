### Changed
- `rig-console` phase 4: "stuck" is derived conservatively.
  - A seat is stuck only when the daemon's quiet signal (activity unknown, stalled, or waiting for input) has lasted N
    minutes (default 15) and its open rows and its own queue transitions haven't moved for N minutes.
  - Each verdict carries its reason and ages. A quiet seat that isn't stuck says why.
  - On the River, each stage shows the median time its open rows have spent in their current state and the share
    waiting. The selected slice shows its time at its stage, worked vs waited.
  - New: `--stuck-minutes`, `:stuck`, `RIG_CONSOLE_STUCK_MINUTES`.
