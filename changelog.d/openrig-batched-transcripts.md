### Fixed
- OpenRig patch 144: transcript rotation no longer forks the daemon once per session. Ticks fall on wall-clock multiples
  of the interval, and the sessions due together share one batched `tmux` read (patch 142's chunked capture), with a
  per-session fallback. A 60 s CPU profile of the stalled daemon (~90 seats) spent 21 s in spawn, mostly from this
  capture, and `/healthz` took up to 6.6 s. On an isolated tmux server, 30 sessions over 7 s took 15 tmux forks instead
  of 120.
- `install.sh` treats `transcripts.poll_interval_seconds` 15 as a floor: a slower interval set on purpose (e.g. 60) is
  kept, and only a faster or missing one becomes 15.
