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
- Credentials: test logins never appear in the browser tool's output: put them in `~/.config/agent-stack/secrets/playwright.env` (0600,
  `NAME=value`, e.g. `WITNESS_PASSWORD=…`) and type them BY NAME: `browser_type` with `text: "WITNESS_PASSWORD"`. The
  Playwright MCP (`--secrets`) types the value and shows `<secret>WITNESS_PASSWORD</secret>` in snapshots and code instead
  of it. Never type a literal password through the MCP, never paste or echo a credential into a message, PR, proof
  file or queue row. If a login isn't in the file yet, ask the lead; never guess or reuse one.
  The MCP echoes every tool input back, so never inline an env or credential value (a token, a key, anything read
  from `.env*`) in `browser_run_code`, `browser_evaluate` or any other tool input: reference secrets by NAME, or let
  the app read them itself.

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
For the owner: on a PASS, save the one screenshot or the journey video that shows the wave working under
`$HOME/.cache/<rig>-tmp/<seat>/proof/` (never `/tmp` or a repo) and give its absolute path to the lead with the result;
the lead sends it to the owner as `--evidence-ref` on an update row (CULTURE "Visual proof for the owner"). It must
show demo or fictional data only: no secrets, tokens or real client data. The Playwright MCP's own files (its
`playwright-mcp/<seat>/` dir) are deleted after 48 hours (hours on a client-data project): to keep one as evidence,
copy it into the slice's proof dir with `rig proof add --media <file>`.

## Proof contract
- [ ] `docs/witnesses/<wave id>.md`: deployed commit, witness agent + model, per-step result, evidence pointers.
- [ ] The wave's rows in the status ledger read `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)`.
- [ ] Every failed step became a fix slice (or a recorded owner decision) before the witness is repeated.
