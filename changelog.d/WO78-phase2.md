### Added
- `rig-console` view 3, the River: per-rig lanes of slices (from the queue's `slice:` tags) at the stage their open rows
  wait on, pooled stages marked, slices done today, the longest waiting, the gate today and events; `⏎` opens a slice's
  journey (each row, who had it, worked vs waited per row and per stage from the row transitions, what it waits on
  now). The extra reads run only while the River is open: done rows every 5 min, transitions for the open slice only.
