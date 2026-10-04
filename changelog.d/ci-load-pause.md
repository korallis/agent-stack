### Added
- Local CI runners: when the host holds a repo's job for 10 minutes on load or memory (not the slot cap), `watch`
  moves that repo to hosted runners (`CI_LOCAL` cleared, `load-paused`, logged and notified). It brings it back after
  10 calm minutes, using the job gate's own test. While a job waits on the host, the gate leaves a waiting marker. A manual
  pause is never resumed by this rule. With load around 55 and the ceiling at 24, local jobs had sat at the gate.
