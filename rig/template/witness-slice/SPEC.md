---
id: <SLICE SPEC ID>
slice: <NN>-w-<env>-witness
mission: <mission>
status: shaped
created: <YYYY-MM-DD>
intent: "A fresh agent walks this mission's features end to end through the real UI on <env>, closing the mission gate"
depends_on: [<every other slice id of this mission>]
witness: true
approved-spec-dial: P1
ui: true
implementer_family: n/a (deploy + fresh witness agent)
test_family: n/a
---

# Slice <NN> — <mission> W: deploy to <env> and agent witness

## Intent
Close the mission: a FRESH agent, one that built, reviewed or tested none of it, uses the deployed product like its real
user and confirms each promised journey works. The next mission (or wave) does not start until this slice is
`agent-witnessed`. Tests, merges and deploys are not witnesses.

Territory: `<status ledger, e.g. PHASE_STATUS.md or features.json>`, `docs/witnesses/<mission>.md` (new). No source code.

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
- [ ] `docs/witnesses/<mission>.md`: deployed commit, witness agent + model, per-step result, evidence pointers.
- [ ] The mission's rows in the status ledger read `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)`.
- [ ] Every failed step became a fix slice (or a recorded owner decision) before the witness is repeated.
