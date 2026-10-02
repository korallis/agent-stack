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
- 2026-10-02: Jev decides; research feeds Jev. Every judgment call (which seat or developer gets a task, which option to take, routing and scope calls, whether a change can merge) goes to Jev (`jev_decide`) as a short candidate list built from the research and evidence; record the Jev decision/request id where the decision is written. Seats bring evidence and options, not conclusions; a lead does not decide these directly. (standing: every seat, every rig) (owner, Slack 18:06Z)
- 2026-10-02: Speed without losing quality: nothing waits unless it must; parallelise independent work across free seats; ship each change as soon as its checks pass (no batching); route reviews and QA to any free eligible reviewer; every quality gate stays. (standing: every seat, every rig) (owner, Slack 18:29Z)

## Operator and lead rules (not the owner's decisions)
Rules the operator or the lead set, and the lead's interpretations of owner decisions, each with its source or doc
link: `- YYYY-MM-DD: <rule> (operator, <ref>)` or `(lead, docs/decisions/<file>)`. They bind the team like the
Operating rules, but they are not the owner's word: an owner decision wins over any of them, and never cite one of
them as the owner's.
- 2026-10-02: Only the owner overrides a Jev result; a lead or seat does not set one aside. (operator, 18:07Z)
- 2026-10-02: A scope or option ruling that no specific Jev decision covers goes to `decide.option`: the question, the criteria, the evidence and at most 12 options your research found. On act, follow it. On review, uncertain or none_fit, escalate with that evidence; never substitute your own pick. (operator, 18:08Z)
- 2026-10-02: Never rebase or force-push a published PR branch (no `gh pr update-branch --rebase`, no `git push --force` on a PR head). To refresh a PR, merge main into it (a normal merge commit). Rewriting published history invalidates every review and CI result and strands collaborators' local branches. (operator, 20:13Z)

## Reading a Jev result (operator rule, 2026-10-02 18:32Z)
- Only `decided_by: jev` is Jev's decision. A `fallback_model` answer is not, whatever its top-level band; when
  only Jev will do, call `jev-decide <id> --no-model-fallback`.
- Act on a Jev result in the act band. On `fallback_model`, review, uncertain or `none_fit`, change nothing and
  escalate to the operator with the question, the options and the Jev record ids; the operator decides whether the
  owner is needed. Merges keep the integrator role's own gate.

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
From Jev `intake.specialist` (2026-10-02), across all four families. `standard.yaml` (16 seats) pins these.
| Work | Seat model |
|---|---|
| Lead / orchestration (holds the backlog) | Opus 5.5 `[1m]`, compacting at 400k |
| Deputy (acts as lead when the lead is out), merge owner, recovery | GPT-6.1 Sol (Codex) |
| Plan decomposition, acceptance criteria, architecture | Opus 5.5 `[1m]` (`standard.yaml`; the older templates keep Fable 5.1); GPT-6 Astra while Claude is scarce |
| Backend implementation | Grok 4.7 Build Fast (native grok seat); else GPT-6.1 Sol |
| Frontend/UI | Sonnet 5.5; UI or backend: GPT-6.1 Sol |
| Locked acceptance tests | Grok 4.7 Build Fast or GPT-6.1 Sol, never the implementer's family |
| Review | Grok 4.7, Kimi K3 (256k) and GPT-6.1 Sol, one seat each: every author has two other families |
| User-level QA | Opus 5.5; GPT-6.1 Sol while Claude is scarce |
| Escalation after two red CI runs on a feature | a fresh seat of another family |
Only leads and architects use a 1M window. Every other seat compacts at 200k, and `agent-project-check` FAILs a
`[1m]` model on any other seat: a 1M seat re-sends up to a million tokens every turn. Keep a seat on its model; route
work to a seat of the right family instead of switching a seat's model (a switch loses its prompt cache). Grok and Kimi
seats run their own CLIs (`agent-native-seat`). The lead routes with Jev `intake.specialist`
over seats that have capacity; code decides anything exact (capacity, retry counts, protected paths, CI status).

