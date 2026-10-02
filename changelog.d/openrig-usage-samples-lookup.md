### Fixed
- OpenRig patch 145: the usage-samples store's latest-row reads use the seat index instead of sorting every row the
  seat ever wrote. That sort ran on every 30 s context-monitor tick for each of ~90 seats, a 2 s event-loop stall in a
  60 s CPU profile of the stalled daemon; the busiest seat's read went from 25 ms to 0.1 ms.
- `install.sh` sets `usage_samples` retention to 7 days (`retention.usageSamplesDays` in `~/.openrig/config.json`,
  which `rig config` doesn't accept); an existing value is kept. OpenRig's own boot and daily sweeps prune in bounded
  batches.
