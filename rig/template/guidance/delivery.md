# Delivery and verification

Read the relevant section before building, authoring acceptance tests, reviewing or witnessing a feature.

## Workflow skills (binding)
Six skills from agent-stack are installed for every seat. Each has a fixed moment:
- `verification-guide`: the architect writes `docs/VERIFY.md` (feature map, exact steps, test data) at project setup
  and updates it in the wave that adds a user-facing area. QA, the bug review board and witnesses follow it.
- `bug-review-board`: QA runs a real-user pass before a PR or wave merges, through the interface its users use: the
  Playwright MCP browser for web, the public command or HTTP API for CLI and API work. Each bug is a queue row to the
  lead with `--mission` and `--slice` (P0/P1/P2, steps, evidence). The ship YES/NO verdict is recorded with `rig proof add`, and
  the integrator puts it in the Jev merge-gate input. A NO blocks the merge.
- `blast-radius`: before signing off a PR that touches shared code, SQL, migrations, env or jobs, the reviewer lists
  what it could break outside the edited files and proves the key safety fact by running code or a read-only query.
  The result goes on the PR. The integrator doesn't merge such a PR without it.
- `review-lenses`: the cross-family reviewer applies the lenses the diff touches (correctness, security and data,
  maintainability, UX and journey, performance) and sorts findings into act on, consider, noted and dismissed.
- Jev decides the routine judgments; code gathers the evidence and owns the thresholds, and anything short of the act
  band goes to a person or the lead: the lead picks seats with `agent-dispatch pick-seat` (Jev's seat on act; on
  review or uncertain the lead picks and writes why in the row), and the merge owner asks the merge gate with
  `agent-merge-evidence --decide` (exact-head evidence; only live Jev `merge` in the act band merges on its own; a
  merge below the act bar, with every deterministic gate green, merges after a one-line exact-head `confirm <sha>` from
  the other-family independent reviewer, as the integrator role says). A Jev HOLD in ANY band (act, review or
  uncertain) blocks the merge unless the owner waives it for that PR (an Owner decisions line with its source); the
  confirm path applies only to a Jev MERGE below the act bar, never to a HOLD.
  `agent-stuck-check` warns the lead when a seat holding work looks looping, rate-limited or stalled; it never acts.
- `unslop` and `technical-writing`: every seat checks its text before posting: PR descriptions, SPECs, issue and PR
  comments (including handbacks to a client), queue bodies and messages to the owner. Plain, specific, short; no
  filler, hype or hedging. Reviewers flag slop in PR text.

## Done means a person could use it (binding)
- Every feature is proven from the user's side, through the interface its users use.
  - A web feature: acceptance tests are browser journeys (Playwright) that do what a person does: open the page, read
    what is on screen, click buttons and links by their visible names, type into labelled fields, and check what the
    person would see next. No test that decides "done" for a web feature may call internal functions, APIs or the
    database, mock the network, inject scripts, set cookies to skip login, or find elements by CSS, XPath or test ids.
  - A feature with no UI (a CLI, or an API that clients call): acceptance tests run the public command, or call the
    public HTTP endpoints, as the user or client would, and check what they get back: output, exit code, files
    written, status and response body. Never internal functions, test-only routes or the database directly.
  Setup a person could not do (seed data, test accounts) goes through documented fixtures, never through the page.
- Unit and integration tests are welcome for the implementer's own safety, but they never count as proof of done.
- Acceptance tests live in `tests/acceptance/` and are written BEFORE the implementation by the test-author seat of the
  other model family. Implementers never edit them; CI fails any implementation PR that touches them. A held-out
  journey suite kept outside the repo is run only by the merge owner before merge.
- The QA seat then uses the running app like a person (the Playwright MCP browser for web; the command or the HTTP API
  otherwise), follows the acceptance criteria by hand, tries the obvious mistakes a real user makes, and records
  evidence on the PR: screenshots or video for web, commands with their output and exit codes, or requests with their
  responses.
- Done also needs an AGENT WITNESS: a fresh agent (one that built, reviewed or tested none of it) walks the feature end
  to end through the interface its users use (the real UI for web; the released command or the deployed API otherwise)
  and records `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)` with evidence. Tests, merges and deploys are not witnesses.
- Every wave with user-facing slices ends with a W witness slice (template: agent-stack `rig/template/witness-slice/`,
  `witness: true`, depends on that wave's slices) that witnesses the wave's features and gates the next wave. The
  mission's last wave W doubles as the mission gate. A docs/infra-only wave may skip it with an explicit
  `no-witness: <reason>` on the wave in mission.yaml.

## Superpowers inside seats
- Implementers and test authors use Superpowers (writing-plans, executing-plans, test-driven-development,
  subagent-driven-development, verification-before-completion). Where a Superpowers step would ask the user a question
  (brainstorming, design choices, finish-branch options), answer it yourself from the slice SPEC.md, features.json and
  the approved acceptance criteria; if they genuinely don't answer it, ask the lead, never the user.
- At the finish-branch step always choose: push the branch and open a ready PR. Never merge locally.

## Reviews and escalation
- Reviewers receive the plan, the feature's acceptance criteria and the diff. They post findings only and never push
  code to someone else's branch; the author applies fixes.
- A feature whose CI goes red twice on the same implementer goes to a fresh seat on the same model (GPT-6.1 Sol), with
  both failure logs; the operator may set GPT-6 Astra for it case by case.
- Risky-tier changes (auth, database migrations, infrastructure, CI/workflows, dependency manifests) also get the Kimi
  third-family review and are held for the owner's glance before merge.

