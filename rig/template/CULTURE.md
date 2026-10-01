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
- Evidence before claims: tests, logs and screenshots attached to the slice with `rig proof add`. Artifacts are .md notes;
  screenshots and video go into the slice's `proof/` dir and are attached with `--media <file>` next to a text note (`--body`, or a text `--file`); never pass an image as `--file`.
- Secrets stay in local env files and the hosting provider; never in code, commits, tasks, tests or logs.
- If you have no owned work, wait quietly.

## Owner decisions (binding; the owner's own decisions only)
Standing decisions, delegations and approvals the owner made, newest last, one dated line each, ending with its
source: `- YYYY-MM-DD: <decision> (scope) (owner, Slack HH:MMZ)` or `... (owner, via operator relay of <ref>)`; the
owner's name may stand for "owner" (the names `agent-owner-address --names` gives). The
lead checks this list before asking the owner anything, and adds every new owner decision here the day it is made. A
decision recorded here is not asked again. Nothing else goes here: an interpretation of an owner decision, a summary
of a lead doc (`docs/decisions/*`) or a rule the operator or a lead set goes under "Operator and lead rules". When an
owner answer is ambiguous, ask (through the operator) before recording it; never record your reading of it.
- (none yet)

## Operator and lead rules (not the owner's decisions)
Rules the operator or the lead set, and the lead's interpretations of owner decisions, each with its source or doc
link: `- YYYY-MM-DD: <rule> (operator, <ref>)` or `(lead, docs/decisions/<file>)`. They bind the team like the
Operating rules, but they are not the owner's word: an owner decision wins over any of them, and never cite one of
them as the owner's.
- (none yet)

## Operating rules (binding)
- Every row to a human (the owner, any `*@external`) gets a short subject: `--summary "<what is now true, or what you
  need>"`, shown as the Slack message's bold title. Without one the `rig` launcher takes the body's first line
  (markdown stripped, at most 80 characters); write it yourself rather than rely on that.
- Human FYIs: send an informational row to the owner (@OWNER@) with `--human-intent update`. It is closed
  automatically once Slack has posted it (`agent-human-inbox-tidy`, every 5 minutes); don't reopen it. A row without
  `--human-intent` counts as a decision and stays open. Decision requests use `--human-intent decision` and
  stay pending until answered: the owner's Slack reply closes a pending row, and parking or claiming it breaks that.
- Visual proof for the owner rides on that update row: add `--evidence-ref <absolute path to a .png/.jpg/.gif/.webp,
  .mp4/.webm/.mov or .pdf>` (at most 50 MiB) and the daemon posts the text, then uploads the file into its Slack thread.
  If the upload fails the text still lands and the daemon logs "attachment missing"; say what the file shows in the
  row's text either way. Make the file outside every repo and never in `/tmp`: in your scratch dir (the `TMPDIR` rule
  below), or the Playwright MCP's own output dir (`browser_take_screenshot` saves under
  `~/.local/state/agent-stack/playwright-mcp/`). In a Playwright script: `await page.screenshot({ path: dir + "/home.png",
  fullPage: true })`; video: `browser.newContext({ recordVideo: { dir, size: { width: 1280, height: 720 } } })`, then
  `await context.close()` and pass `await page.video().path()` (a .webm). Only test accounts and synthetic data on
  screen: no secrets, tokens, real customer or client data, or other projects' windows.
- Heavy runs share the machine: wrap every tsc, eslint, vitest/jest, `npm test`, `next build`, Playwright run and full
  test suite in `agent-heavy build -- <cmd>` (`agent-heavy browser -- <cmd>` for Playwright and other browser tests). It
  holds a shared slot (2 at once, capped CPU and RAM) so a burst of seats can't starve the host or the OpenRig daemon.
  Prefer the focused run (the files or journeys you touched) over the full suite; run the full suite once, at the end.
  Never wrap a server (`npm start`, `npm run start:*|dev|serve|preview`, `next start|dev`, `vite`): it never finishes and
  would hold a shared slot. agent-heavy refuses it; run it outside and wrap only the tests that use it. Jobs are stopped
  at a max runtime (45min build, 30min browser; `--max-runtime` to raise it) and killed past a memory ceiling (14G
  build, 8G browser, 24G for all heavy runs; exit 137). Run test runners with few workers (`node --test
  --test-concurrency=4`, `jest --maxWorkers=4`); a run killed for memory is rerun focused, not just repeated.
- Never `pkill -f`/`killall` by a pattern: it also matches other seats' command lines. Stop your own processes by PID
  (`pgrep -f` narrowed by cwd or parent PID, then `kill <pid>`).
- Never print a credential: connection strings, passwords, API keys and tokens never go to a command's output (it is
  your transcript) or into a tool input. Write them to a 0600 file (`neon cs … --output-file <path>`; the seat guard in
  front of `neon` and `vercel` refuses anything else) and use them by name. A flag the installed CLI's `--help` doesn't
  list may be silently ignored: check before relying on it. If a secret was printed, tell the owner at once so it gets
  rotated.
- Credential files (`.env*`, `*runtime-url*`, `*.pem`, the secrets directory) are never printed or read into the
  transcript: a machine-wide hook refuses it. Load them by name (`set -a; . <file>; set +a; <command>`, `--env-file`)
  and never work around a refusal.
- Context wall: when your context passes ~85%, write your handover packet (open work, decisions WITH rationale under a
  "Decisions" heading, facts you couldn't check marked `UNVERIFIED:`) and publish it with
  `agent-seat-recap write <packet.md> [--learned <lessons.md>]`. It becomes your seat's RECAP.md, the first thing a
  `rig seat handover --source rebuild` successor reads; lessons for every later occupant go to LEARNED.md. A packet
  anywhere else is never read by the rebuild. Check with `agent-seat-recap show`.
- Scratch checkouts for review or QA go under `~/Projects/<P>.worktrees/`, never `/tmp`, and are removed in a
  `finally`/`trap`. Test suites remove every `mkdtemp` directory they create.
- `TMPDIR` and other temporary scratch go on disk and OUTSIDE any git repo, under the seat's root
  `$HOME/.cache/<rig>-tmp/<seat>`: each job makes its own directory there and its `trap` removes only that one (other
  jobs of the seat may be using the root at the same time). Never `/tmp` (a RAM disk on these hosts: a big scratch run
  takes memory from every seat), and never inside a worktree (tests treat a directory under a git repo as a checkout).
  In a seat (its session name is `<seat>@<rig>`), this sets it up; the trap names the job's directory as it was made:
  `s=${OPENRIG_SESSION_NAME:-$USER@local}; d="$HOME/.cache/${s#*@}-tmp/${s%@*}"; mkdir -p "$d"; export TMPDIR=$(mktemp -d "$d/job.XXXXXX"); trap "rm -rf -- $(printf %q "$TMPDIR")" EXIT`
- Proof for a project in the workspace catalog: `rig proof show|judge <project-id>:<mission>/slices/<slice>` (the catalog
  id). Never switch the daemon's workspace to judge.
- Never prompt: every seat runs without permission prompts (agent-stack README, "Never prompt";
  `agent-never-prompt-check`).
- Merge gate: an independent review from the other model family, then live Jev `review.merge_gate` in the act band,
  then a merge pinned to the reviewed head. The merge owner's procedure is in the integrator role guidance.

## Research, plan, implement (binding)
Research -> plan -> implement (owner standard, 2026-09-30): every slice, feature, fix and wave starts with research and
  a plan, before any code.
  1. Research: read the code, tests, data and docs the work touches; reproduce the bug or current behaviour; note the
     findings with file:line, and say what you could not confirm.
  2. Plan: the approach, the files to change (inside the Territory), the tests to write first, and the risks and
     rollback. Size it to the work: a few lines for a small fix.
  3. Only then implement.
  Record both under `## Research` and `## Plan` in the slice's PROGRESS.md before the first code commit. The architect
  records a wave's research and plan in the mission SPEC before the wave is dispatched. The lead doesn't dispatch
  builders on a slice whose SPEC lacks research; reviewers send back a PR whose slice has no Research/Plan.

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
| Deputy, merge owner, recovery | GPT-6.1 Sol (Codex) |
| Plan decomposition, acceptance criteria, architecture | Fable 5.1 (`team.yaml` keeps Opus 5.5) |
| Volume implementation, unit tests, lint/renames/docs | GPT-6.1 Sol (Codex) |
| Frontend/UI and large migrations | Sonnet 5.5 |
| Escalation after two red CI runs on a feature | a fresh seat on the same model (GPT-6.1 Sol); the operator may set GPT-6 Astra case by case |
| Locked acceptance tests | the family that is NOT implementing the feature (Sonnet 5.5 or GPT-6.1 Sol) |
| User-level QA | GPT-6.1 Sol (Codex) |
| Review of Codex PRs / of Claude PRs | Opus 5.5 / GPT-6.1 Sol |
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
- A feature whose CI goes red twice on the same implementer goes to a fresh seat on the same model (GPT-6.1 Sol), with
  both failure logs; the operator may set GPT-6 Astra for it case by case.
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

