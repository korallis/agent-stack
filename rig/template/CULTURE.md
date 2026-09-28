# Team culture (shared by every repo's rig)

- The repository's own AGENTS.md / AGENT_WORKFLOW.md / CONTRIBUTING.md are binding. When they conflict with anything here, they win.
- One owner per queue item and per worktree. Claim before working; hand off explicitly (`rig queue claim` / `rig queue handoff`).
- The repo's tracker (issues/project, task docs) is the source of truth for status. OpenRig slices point to it.
- Every agent keeps the issues current so the owner can follow progress from GitHub alone: on claim, move the issue
  to In progress and comment the owner seat and branch; comment at each milestone (plan agreed, PR opened with link,
  review findings and fixes, blocked with what/who is needed, merged with PR + commit); keep the acceptance checklist
  and project Status in step (Ready → In progress → In review → Done, or Blocked with the reason). The merge owner
  reconciles the issue straight after every merge.
- Only Ready work is started. Blocked work stays blocked until its dependency is really done.
- Pull requests are ready (never drafts) and reviewed by a seat that did not author them, preferring the other model family.
- One merge owner (the integ-* seat) merges every PR, one at a time, as soon as CI, the independent review and live Jev agree. Nobody else merges, and no PR is left waiting.
- Evidence before claims: tests, logs and screenshots attached to the slice with `rig proof add`.
- Secrets stay in local env files and the hosting provider; never in code, commits, tasks, tests or logs.
- If you have no owned work, wait quietly.

## Done means a person could use it (binding)
- Every feature is proven from the user's side. Acceptance tests are browser journeys (Playwright) that do what a person
  does: open the page, read what is on screen, click buttons and links by their visible names, type into labelled
  fields, and check what the person would see next. No test that decides "done" may call internal functions, APIs or
  the database, mock the network, inject scripts, set cookies to skip login, or find elements by CSS, XPath or test ids.
  Setup a person could not do (seed data, test accounts) goes through documented fixtures, never through the page.
- Unit and integration tests are welcome for the implementer's own safety, but they never count as proof of done.
- Acceptance tests live in `tests/acceptance/` and are written BEFORE the implementation by the test-author seat of the
  other model family. Implementers never edit them; CI fails any implementation PR that touches them. A held-out
  journey suite kept outside the repo is run only by the merge owner before merge.
- The QA seat then uses the running app like a person (Playwright MCP browser), follows the acceptance criteria by hand,
  tries the obvious mistakes a real user makes, and records screenshots or video as evidence on the PR.

## Search and context
- Search with `rg` (content) and `rg --files` / `fd` (file names). Never `grep -r` or `find` for searching.
  Narrow with `-g '<glob>'`, cap with `-m <n>`, and never pipe an unbounded recursive search into context.
- When you hand tabular data to another seat or put it in a prompt (queue lists, test/CI results, findings, file
  inventories), convert JSON to TOON first: `... | toon`. Keep files that tools or agents edit in their own format
  (features.json, RigSpecs, configs, CI workflows).

## Models and routing (who does what)
| Work | Seat model |
|---|---|
| Lead / orchestration (holds the whole backlog; 1M context) | Opus 5.5 `[1m]` |
| Deputy, merge owner, recovery | GPT-6 Sol (Codex) |
| Plan decomposition, acceptance criteria, architecture | Opus 5.5 |
| Volume implementation, unit tests, lint/renames/docs | GPT-6 Sol (Codex) |
| Frontend/UI and large migrations | Opus 5.5 |
| Escalation after two red CI runs on a feature | GPT-6 Astra (Codex), escalations only |
| Locked acceptance tests | the family that is NOT implementing the feature (Opus 5.5 or GPT-6 Sol) |
| User-level QA | GPT-6 Sol (Codex) |
| Review of Codex PRs / of Claude PRs | Opus 5.5 / GPT-6 Sol |
| Third review on risky changes, long-context reading | Kimi K3 (1M) |
Fable 5.1 is the Claude fallback when Opus 5.5 is rate-limited. The lead routes with Jev `intake.specialist`
over seats that have capacity; code decides anything exact (capacity, retry counts, protected paths, CI status).

## Superpowers inside seats
- Implementers and test authors use Superpowers (writing-plans, executing-plans, test-driven-development,
  subagent-driven-development, verification-before-completion). Where a Superpowers step would ask the user a question
  (brainstorming, design choices, finish-branch options), answer it yourself from the slice SPEC.md, features.json and
  the approved acceptance criteria; if they genuinely don't answer it, ask the lead, never the user.
- At the finish-branch step always choose: push the branch and open a ready PR. Never merge locally.

## Reviews and escalation
- Reviewers receive the plan, the feature's acceptance criteria and the diff. They post findings only and never push
  code to someone else's branch; the author applies fixes.
- A feature whose CI goes red twice on the same implementer is escalated by the lead to the Astra seat with both failure logs.
- Risky-tier changes (auth, database migrations, infrastructure, CI/workflows, dependency manifests) also get the Kimi
  third-family review and are held for the owner's glance before merge.
