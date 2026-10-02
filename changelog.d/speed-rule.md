### Added
- New rigs get the owner's standing order "Speed without losing quality" (2026-10-02) in CULTURE's Owner decisions:
  nothing waits unless it must; independent work runs in parallel across free seats; each change ships as soon as its
  checks pass (no batching); reviews and QA go to any free eligible reviewer; every quality gate stays.
- New rigs' CULTURE gets a short "Reading a Jev result" section (operator rule): only `decided_by: jev` is Jev's
  decision, not a `fallback_model` answer whatever its band; on fallback, review, uncertain or `none_fit`, change
  nothing and escalate to the operator with the question, options and Jev record ids.
