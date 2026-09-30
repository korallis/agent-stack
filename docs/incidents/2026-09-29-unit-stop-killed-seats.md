# 2026-09-29 ~16:30Z: stopping the daemon unit (openrig.service) stopped 84 seats

## What happened
Stopping the daemon's unit stopped every seat on the machine (84), not just the daemon.

## Why
The tmux server that holds every seat had been started inside `openrig.service`. tmux creates each pane's scope with
`PartOf=<the unit its server was started in>`, so stopping the unit stopped every pane scope, and with them every
Claude and Codex seat. `PartOf=` propagates restarts too (systemd.unit(5)), so a restart of the unit is just as
dangerous.

## Recovery
Every seat was restored from OpenRig's snapshots onto its own conversation: 0 fresh starts, so no seat lost its
context.

## Prevention (WO5)
- Seats live in their own unit, `openrig-tmux.service` (`RefuseManualStop=yes`); `openrig.service` only runs the
  daemon and never owns a seat.
- The daemon is restarted with `openrig-daemon-cycle` (verified stop, start in its own scope), never with
  `systemctl stop|restart openrig.service`.
- `openrig-tmux-adopt --apply` moves an already-running tmux server out of `openrig.service` without stopping a
  seat.
- A test checks that no script or doc in this repo stops or restarts `openrig.service`.
