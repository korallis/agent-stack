### Fixed
- `agent-stuck-check`: a row parked on a named blocker (state blocked) no longer counts as open work, so an idle seat
  whose only rows are parked isn't flagged as stuck. OpenRig's assigned count includes parked rows, so only work beyond
  them counts; when the queue list can't be read, the assigned count still decides.
