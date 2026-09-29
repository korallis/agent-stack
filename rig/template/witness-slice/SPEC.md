---
id: <SLICE SPEC ID>
slice: <NN>-<wave id>-witness   # e.g. 11-w02-witness; name ends in "witness"
mission: <mission>
status: shaped
created: <YYYY-MM-DD>
intent: "A fresh agent walks this wave's features end to end through the real UI on <env>, gating the next wave"
depends_on: [<every other slice id of this wave>]
witness: true
approved-spec-dial: P1
ui: true
implementer_family: n/a (deploy + fresh witness agent)
test_family: n/a
---

# Slice <NN> — <wave id> W: deploy to <env> and agent witness

## Intent
Close the wave: a FRESH agent, one that built, reviewed or tested none of it, uses the deployed product like its real
user and confirms each of this wave's promised journeys works. The next wave does not start until this slice is
`agent-witnessed`; in the mission's last wave it is also the mission gate. Tests, merges and deploys are not witnesses.
Add it as the last member of its wave in mission.yaml (or as its own follow-on wave `<wave id>w`).

Territory: `<status ledger, e.g. PHASE_STATUS.md or features.json>`, `docs/witnesses/<wave id>.md` (new). No source code.

## Mini-requirements

### Deploy (merge owner / ops)
Deploy the merged main at a recorded commit to `<env>` the way the repo's AGENTS.md says. Confirm the deployed commit and
health before the witness starts. A failed deploy parks this slice with a wake; it is not a witness failure.

### Witness walk (fresh agent, through the real UI on <env>)
1. <journey 1: what a real user does, step by step, and what they must see>
2. <journey 2 …>
3. <the obvious mistakes a real user makes, and what must happen>
4. <access/permission boundary, if the product has users with different rights>

Evidence: screenshots or video per step, stored where the project allows. Sensitive or client data never goes into git,
PRs or the queue; the repo record holds counts, IDs, pass/fail and redacted regions only.

## Proof contract
- [ ] `docs/witnesses/<wave id>.md`: deployed commit, witness agent + model, per-step result, evidence pointers.
- [ ] The wave's rows in the status ledger read `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)`.
- [ ] Every failed step became a fix slice (or a recorded owner decision) before the witness is repeated.
