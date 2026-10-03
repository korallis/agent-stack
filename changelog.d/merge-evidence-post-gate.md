### Added
- `agent-merge-evidence --decide` posts a pass itself: on a live Jev merge in the act band with every gate it checks green
  (exit 0), it posts the PR comment (verdict line, raw request, raw response) and then the `jev-merge` success status on
  the exact head, with the request id in its description and linked to that comment. It never posts for a review or
  uncertain band, a fallback, a stubbed answer, HOLD, NEEDS CONFIRM or an error. `--no-post` is a dry run, and a failed
  post exits 5. Integrators had hit "branch policy blocks merge" after forgetting the status. The integrator role text
  matches.
