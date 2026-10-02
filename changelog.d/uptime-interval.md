### Added
- `agent-uptime-watch`: an optional per-monitor `interval_minutes` in `uptime.json` (1 to 1440, default 1) probes that
  endpoint only once its interval has passed since the last probe, so a backend behind the health endpoint can idle.
  Down alerts still need 15 minutes of failed observations; an observation gap up to two intervals counts as one outage.
