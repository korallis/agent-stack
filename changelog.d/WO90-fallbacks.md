### Added
- Family fallback chains per role (`config/routing.json`), used by dispatch, `agent-recover` and the new
  `agent-reroute`. A seat can take work when its family has an eligible account that isn't cooling on its model. A
  model cooling on one account is still served by the others; a credential-wide cooldown takes the account out.
  Native grok/kimi seats are dispatch targets with their own family. A pick past the role's first family records why
  each earlier family was passed. The Claude lead and architect fall back to the Codex deputy (`_role_fallback`).
- Review matrix: the reviewer is never the author's seat, and never the author's family while another family has a
  free reviewer (in the reviewer chain's order). The handed-off row's note records the choice and what was skipped.
- `agent-reroute` (timer every 10 minutes) moves work stuck on a seat that can't take it:
  - rows pending 20+ minutes on a dead, unservable or context-full seat;
  - claimed rows on an idle seat whose model the proxy can't serve. The proxy's 429 "all credentials for <model> are
    cooling down" ends the turn. This held Claude seats still for 1h20 on 2026-10-02.

  Rows move after 5 minutes when the cooldown is long. Each row moves at most once, never to a human, with an audit
  note. Destinations must be idle, servable and below their context wall. A moved row keeps its work's independence:
  a review stays away from its author's family, and an implementation from its locked tests' family. A row that
  implies a constraint it doesn't state goes to the lead (`agent-recover` too). Seats served again get one resume
  message for the claimed rows they still hold, retried if the send fails. review-plan now writes the author on the
  review row.

### Fixed
- The proxy reports Kimi as `kimi-ai`. Kimi never counted as out of accounts, and pick-seat ignored grok.
- `agent-recover` classifies the cooling-down 429 as `rate_limited` in code. When every eligible account cools on
  the seat's model it reports `MODEL OUT` and offers reassign to another family instead of retrying. Its pool check
  now reads the proxy's `retry_at`. It calls Jev through the test stub hook (`AGENT_JEV_STUB`), like dispatch.
