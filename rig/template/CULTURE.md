# Team culture

Repository AGENTS.md, AGENT_WORKFLOW.md and CONTRIBUTING.md take precedence. Use judgment to ship the
assigned outcome with evidence. Keep one owner per queue item and worktree; claim ready work before starting.
The repository tracker is the status authority. Update its issue on claim, PR, blocker and merge, with links
and acceptance progress. If you have no owned work, wait quietly.

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

## Owner communication

Respond to the owner in English, in every rig and on every harness. Use these three headings for replies,
updates and decision requests: `What`, `Why`, `Recommendations`.
State the result or request under What, its reason under Why, and anything the owner should do under
Recommendations. Say "No action needed" when there is nothing for the owner to do. Keep each section brief.
Human queue rows also need a specific `--summary`; the headings belong in the body.

## Operating rules

- Credentials and client data stay out of code, commits, tool inputs, transcripts and screenshots. Load credential
  files by name; do not print them or bypass the read guard. Report an exposure to the owner for rotation.
- Work in your own worktree. Preserve OpenRig managed blocks, but do not commit them. Stop only your own processes
  by PID; no pattern-based killall or pkill. Destructive operations and publication need the applicable authority.
- Run tests, builds and lint through `agent-heavy build -- <cmd>`; browser tests use `agent-heavy browser -- <cmd>`.
  Servers run outside the limiter. Use focused runs and few workers. Read `guidance/host-operations.md` before
  scratch setup, heavy work, credential CLI use or context handover (paths resolve under `$OPENRIG_WORK_ROOT/rig`).
- Send an informational row to the owner (@OWNER@) with `--human-intent update`; requests use
  `--human-intent decision`. Give human rows a `--summary`. Read `guidance/coordination.md` before sending one,
  especially for proof attachments; leave decision rows pending until answered.
- Slice boundary: after the next owner has the queue handoff, publish a fresh recap and ask the lead or recovery
  seat to start a fresh session at idle with `agent-seat-handover <seat> --source rebuild --reason slice-boundary`.
  Record remaining work and wakes first. Use the "Slice-boundary session refresh" procedure in agent-stack
  `docs/REFERENCE.md`; do not clear an active turn or reset before custody has passed.
- Near the context wall, publish a fresh packet with `agent-seat-recap write <packet.md>`; include decisions and
  rationale, open work and `UNVERIFIED:` facts. Check `agent-seat-recap show` before an idle-gated handover.
- Seats run without permission prompts (`agent-never-prompt-check`). Follow owner approvals already recorded here.
- Search narrowly with `rg` or `fd`. Keep machine inputs as JSON; use TOON for tables agents read.
- GitHub calls share one account: at most one status check per minute; on a rate limit wait two minutes and retry
  once. Read `guidance/coordination.md` for sweep and human-message procedures when they are your work.

## Research, plan, implement

Before code, inspect the relevant source and reproduce the behavior. Record `## Research` (file:line evidence
and unknowns) and `## Plan` (approach, territory, tests, risks, rollback) in the slice PROGRESS.md. Size the plan
to the work. The architect records wave research and plan in the mission SPEC before dispatch.

## Workflow skills

Load detail when its task arrives. Your role's first message holds its workflow; other roles' procedures are
on demand in `guidance/delivery.md` and `guidance/coordination.md`, under `$OPENRIG_WORK_ROOT/rig`.

| Work you are doing | Read at that boundary |
|---|---|
| Implementing or authoring tests | delivery.md: Superpowers inside seats; Done means a person could use it |
| Planning or dispatching | coordination.md; `verification-guide` for docs/VERIFY.md; `agent-dispatch pick-seat` |
| Reviewing | delivery.md: Reviews and escalation; `review-lenses` and `blast-radius` for shared-code risk |
| QA or witnessing | delivery.md: Done means a person could use it; `bug-review-board`; docs/VERIFY.md |
| Merging | Integrator role guidance; delivery.md: Workflow skills; coordination.md for reconciliation |
| Posting text | `technical-writing` and `unslop` |

Prove user-facing work through its real UI, public command or public API. Unit tests alone do not establish
acceptance. Test authors own locked acceptance journeys; implementers do not edit or weaken them. QA performs
a real-user pass. User-facing waves end with an independent W witness slice; docs/infra exceptions need an
explicit no-witness reason. Full verification rules remain in `guidance/delivery.md` and apply at these boundaries.
Attach evidence with `rig proof add`: screenshots/video use `--media <file>` next to text; never pass an image as `--file`.

Open ready PRs. The merge owner alone merges serially, pinned to the reviewed head after required CI, independent
other-family review, exact-head QA PASS and live Jev. HOLD or fallback blocks. A below-act MERGE needs the
other-family reviewer's exact-head confirmation. Risky changes retain third-family review and owner approval.
The integrator role describes the complete gate; this short summary does not replace it.

Work lives in project.yaml, mission and slice files. Queue rows retain mission, slice, project and worktree tags.
Use `mission-slice-sop` and `queue-handoff`: hand off work or park it with a wake. Wave builders work in disjoint
territories in parallel; wave review remains additional to per-PR checks. QA and the merge owner judge proven
proof-contract items with `rig proof judge`.

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

