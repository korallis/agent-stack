### Added
- New rigs get the owner's standing rule "Jev decides; research feeds Jev" (2026-10-02) in CULTURE's Owner decisions.
  Every judgment call goes to Jev as a short candidate list built from the research; seats bring evidence and
  options, not conclusions. An operator rule adds that only the owner overrides a Jev result. The lead, deputy and architect roles and the seat startup
  text point to it.
- Jev decision `decide.option` (v1): the generic bounded choice for scope and option rulings that no specific decision
  covers. It takes `question` and `criteria` (required) and `evidence` (optional), and picks one of 2-12
  caller-supplied options or answers `none_fit`. It is never cached, and when Jev is unavailable the fallback is
  `none_fit` (the caller escalates; no model guesses). It is documented in the agent-stack skill and as an operator
  rule in the template CULTURE.
