### Fixed
- OpenRig 0.6.3 patch `143-remove-exited-session` (upstream 48f6cce7, mvschwarz/openrig#431 for #403): `rig remove`
  and `rig shrink` no longer stop with `kill_failed` on a seat whose tmux session has already exited ("can't find
  window"), which left ghost nodes in the rig. Termination confirms the session's absence with `has-session` and
  removal goes on; other failures still refuse.
