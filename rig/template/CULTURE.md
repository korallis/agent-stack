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

## Owner decisions (binding; check before asking the owner)
Standing decisions, delegations and approvals from the owner, newest last, one dated line each:
`- YYYY-MM-DD: <decision> (scope; how it was given)`. The lead checks this list before asking the owner anything, and
adds every new owner decision here the day it is made. A decision recorded here is not asked again.
- (none yet)

## Operating rules (binding)
- Human FYIs: send an informational row to the owner (lee@external) with `--human-intent update`. It is closed
  automatically once Slack has posted it (`agent-human-inbox-tidy`, every 5 minutes); don't reopen it. A row without
  `--human-intent` counts as a decision and stays open. Decision requests use `--human-intent decision` and
  stay pending until answered: the owner's Slack reply closes a pending row, and parking or claiming it breaks that.
- Scratch checkouts for review or QA go under `~/Projects/<P>.worktrees/`, never `/tmp`, and are removed in a
  `finally`/`trap`. Test suites remove every `mkdtemp` directory they create.
- Proof for a project in the workspace catalog: `rig proof show|judge <project-id>:<mission>/slices/<slice>` (the catalog
  id). Never switch the daemon's workspace to judge.
- Never prompt: every seat runs without permission prompts (agent-stack README, "Never prompt";
  `agent-never-prompt-check`).
- Merge gate: an independent review from the other model family, then live Jev `review.merge_gate` in the act band,
  then a merge pinned to the reviewed head. The merge owner's procedure is in the integrator role guidance.

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
- Done also needs an AGENT WITNESS: a fresh agent (one that built, reviewed or tested none of it) walks the feature end
  to end through the real UI on the deployed environment and records `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)`
  with evidence. Tests, merges and deploys are not witnesses.
- Every mission ends with a W witness slice (template: agent-stack `rig/template/witness-slice/`, frontmatter
  `witness: true`, depends on all the mission's slices) in its own last wave. It gates the next mission or wave.

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

## GitHub API is shared (binding)
- Every seat of every rig uses the same GitHub account, and GitHub blocks the whole account for a while when calls burst.
  Never poll in a tight loop. Wait at least 60 seconds between status checks (for example
  `gh pr checks <n> --watch --interval 60`), run at most one waiting loop per seat, and prefer one `gh api` REST call
  over repeated `gh pr view` / `gh pr list` (those use GraphQL).
- On any "rate limit" or "secondary rate limit" error: stop GitHub calls for 2 minutes, then retry once. Do not retry
  in a loop, and do not switch to a different command to get around it.
- The merge owner's 15-minute sweep is the default rhythm for PR status; other seats do not poll PRs they are not
  actively working on.

## Projects, missions, slices and waves (OpenRig conventions)
- Work lives in the project workspace (`$OPENRIG_WORK_ROOT`): project.yaml → missions/<m>/ (SPEC, PROGRESS, NOTES, mission.yaml) → slices/<s>/ (SPEC, PROGRESS, PROOF, proof/). Use the `mission-slice-sop` and `queue-handoff` skills; references in `$OPENRIG_HOME/reference/` (sdlc-conventions.md, wave-sdlc.md, product-journey-sdlc.md).
- Waves: slices build in parallel in disjoint file territories; the merge owner merges serially; the independent wave review fires once per wave on top of the per-PR checks. Waves live in each mission.yaml `arrangement.waves` (members = slice SPEC ids), maintained by the lead; the TUI reads only that.
- Every queue row names its mission and slice (`--mission`, `--slice`); the seat `rig` adds `project:<id>` and `worktree_path=`. Don't strip them.
- End every turn by passing the ball (`rig queue handoff`) or parking it WITH a wake (`rig queue block … --wake-after`); never go idle holding work.
- Proof: QA and the merge owner accept each proof-contract item with `rig proof judge` once it is shown to work; readiness in the TUI comes only from those judgments.
- Keep slice/mission status honest; the files serve the product, not the other way round.
- Your AGENTS.md / CLAUDE.local.md carries OpenRig managed blocks (your instructions). Never discard them (`git checkout -- AGENTS.md`, `git restore .`, `git stash -u`, resets) and never commit them: stage your own lines with `git add -p`. A pre-commit hook refuses commits containing them.

