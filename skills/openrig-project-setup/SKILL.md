---
name: openrig-project-setup
description: >
  Set up, audit or repair a project for an OpenRig build team on this machine the correct way: repo +
  starter kit, workspace (project.yaml, missions, slices), rig, worktrees, wave maps, queue tagging and the
  seat skills. Use when starting a new project or rig, adding a project, when a rig looks idle or its TUI
  Project view is empty/wrong, when waves or missions seem missing, or before dispatching builders wide.
metadata:
  openrig:
    owner: agent-stack
    source_ref: https://github.com/korallis/agent-stack/tree/main/skills/openrig-project-setup
    version: "2026-09-29"
    stage: shipped
    last_verified: "2026-09-29"
    source_evidence: "agent-project-check MTA / HC-Prime: 0 FAIL 0 WARN; rig spec audit clean; rig doctor --spec conformance OK; OpenRig 0.5.17 references"
---

# OpenRig project setup (agent-stack)

These tools do the mechanical work; don't hand-build what they do:

| Tool | Does |
|---|---|
| `agent-project-new --name <P> --rig <short> --github <user> [--team full-stack\|build\|core]` | Repo from the starter kit, held-out dir, private GitHub repo (REST) + protection, workspace with the agent-stack SDLC/wave/git defaults, umbrella catalog + allowlist + scan roots, rig folder, one worktree per seat, `.git/info/exclude`, `rig up`, merge-sweep + daily-summary watchdogs (never duplicated), then the check. Idempotent: re-run it to repair. `--dry-run` shows the plan. |
| `agent-project-repair <P> [--apply]` | Brings an existing project up to what the daemon reads: `rig scope mission repair`, official `metadata:` blocks, `proofPolicy.judges`, `approved-spec-dial`, waves into mission.yaml, queue backfill, seat instruction refresh. Backs up the workspace first. |
| `agent-waves-sync <P> [--apply] [--force]` | Copies each mission's wave map into mission.yaml `arrangement.waves` (SPEC ids); delivered slices get `w00-delivered`. |
| `agent-queue-backfill <P> [--apply] [--candidates]` | Adds `project:`, `slice:`/`mission:` tags and `worktree_path=` to a project's EXISTING queue rows (additive, after a DB backup). Use once when the check WARNs about untagged rows from before the seat helper. `--candidates` adds `candidate:<PR head sha>` per built slice. Gathers everything first, then writes in ONE short transaction. |
| `agent-refresh-guidance <P> [--apply]` | After editing the rig's `CULTURE.md` or `startup/*.md` on a running rig: refreshes those OpenRig managed blocks in every seat's instruction file, adds blocks for startup files added to the spec later, and restores a seat whose file lost all blocks. Then tell the lead to have seats re-read their instruction file. |
| `agent-project-check <P>` | Read-only audit. Checks files AND asks the daemon every question the TUI asks (`/api/scopes`, `/api/views/execution` per mission): waves, readiness, planning dial, review model, repo context, lanes; plus rig doctor/spec audit, seats' blocks and skills, local main vs origin, timers, hooks, never-prompt (`agent-never-prompt-check`). FAIL = the team or the TUI will misbehave. Run after setup, after planning, whenever the TUI looks wrong. |

Sources of truth: `$OPENRIG_HOME/reference/` — `rig-spec.md`, `agent-spec.md`, `agent-startup-guide.md` (skills
reach seats two ways: projected by the agent spec AND named in the role text; rig-level `startup/context.md`),
`sdlc-conventions.md` (Part A, DISPATCH DATA EC-1..3),
`wave-sdlc.md`, `product-journey-sdlc.md`, `project-workspace.md`, `planning-dial.md` — and the OpenRig skills
`mission-slice-sop` and `queue-handoff`. Read those, not memory, when in doubt.

## The audit principle (learned the hard way)
Verify through the CONSUMER, not the convention. A doc can describe a format the daemon only uses as a
fallback (waves as queue rows); a file can look right and still be ignored (mission.yaml without
`metadata:`). The authority is what the daemon returns to the TUI: read the daemon code when a field is
INDETERMINATE (`$L/openrig/lib/node_modules/@openrig/cli/daemon/dist/domain/execution-view.js`,
`proof/judgments.js`, `review/*.js`) and compare with the official worked example
(`rig context get skills/core/openrig-software-factory/references/worked-example.md`).
Remaining INDETERMINATEs that are by design: `reviewed` in project views (review artifacts have no project
binding) and `adopted` (compares with OpenRig's own build) — not project faults.

## The order
1. `agent-project-new …` (machine prerequisites come from `~/Projects/agent-stack/install.sh`).
2. The owner writes `docs/PLAN.md`; send ONLY the lead: `rig send coord-lead-claude@<rig> "Build docs/PLAN.md"`.
3. The lead + architect produce, before any build dispatch:
   - `features.json` and one mission per area, slices under it (`rig scope …`), every slice SPEC.md with
     `intent`, honest `status`, `depends_on` (inline JSON array; `[]` is a statement), `## Intent`,
     `## Mini-requirements`, `## Proof contract`, a `Territory:` line, `SOFT-AFTER: [ids] — reason` on overlap;
   - waves in each mission.yaml `arrangement.waves` (members = slice SPEC ids): slices that build in
     parallel in disjoint territories; load-bearing slices (auth, migrations, payments) get their own wave;
     every new slice joins a wave when created. A draft from dependency levels is a fine start.
   - official YAML shape: `metadata:` in project.yaml (id), mission.yaml (name, status), slice.yaml (id);
     `approved-spec-dial:` in slice SPEC frontmatter; `proofPolicy.judges` in project.yaml.
4. `agent-project-check <P>` — no FAIL before builders are dispatched wide.
5. QA and the merge owner `rig proof judge` each proof item after a pass (that is the TUI's readiness).
6. Build per wave; the wave review (two non-writer reviewers of different families; drift +
   CONTEXT-GAP / JUDGMENT-GAP) fires once per wave on top of the per-PR checks.

## Mistakes this setup already made once (each is now prevented — keep it that way)
- **No waves.** Missions and slices existed, but no wave-map rows: dispatch was one-by-one and the idle
  seats stayed idle. → lead role step 1, check FAILs on a mission with open slices and no map.
- **Seats never had OpenRig's own skills** (mission-slice-sop, queue-handoff, …): the rig specs name the
  `shared:openrig-core` plugin but seats start without `--plugin-dir`, so it never loaded. → install.sh
  symlinks all core skills into `~/.claude/skills` and `~/.agents/skills`; the check FAILs without them.
- **Queue rows the project views couldn't place:** no `project:<id>` tag, no `worktree_path=` (EC-3). → the
  `rig` launcher routes seat `queue create/handoff` through `seat-tools/rig`, which adds both. Still pass
  `--mission` and `--slice` yourself. Old rows: `agent-queue-backfill <P> --apply` (additive).
- **Stale status** (slices left `placeholder`/`shaped` after delivery) and an **empty leftover mission**. →
  lead role step 7; check WARNs.
- **No SDLC/git declaration** in project.yaml. → `rig/template/project-sdlc.yaml` appended by the setup.
- **Everyone messaged instead of the lead**; owner asked for decisions Jev could make; risky PRs waiting on
  an owner who had given standing approval. → message only the lead; record standing approvals and
  delegations in the rig `CULTURE.md` "specifics" section, where every role reads them.
- **Port collisions** between seats' test servers → per-seat `E2E_PORT` (env.sh) and the kit's Playwright
  config; **GitHub GraphQL burst limits** with 27 seats → REST for repo creation, ≥60 s polling.
- **Duplicate watchdogs** (a seat re-registering the merge sweep) → setup registers only when absent; the
  check FAILs on more than one merge sweep. Parked-row wake timers (`rig queue block --wake-after`) are fine.
- **No rig-level startup context** (`rig spec audit` finding) → `rig/startup/context.md` (identity, environment,
  system check, skills to load) declared as a rig `startup.files` guidance_merge entry in every team spec.
- **Role text never named the role's skills** (the startup guide's belt-and-suspenders rule) → every role.md
  starts with "Skills to load: …"; the architect also has requirements-writer / ui-mockup / plan-review, QA dogfood.
- **Running seats kept launch-time rules** after CULTURE.md changed, and **two seats lost every OpenRig block**
  (a git reset/merge of AGENTS.md wipes them). → `agent-refresh-guidance --apply`; culture rule "never discard
  or commit managed blocks"; check FAILs on a seat without blocks.
- **Codex seats' blocks live in the tracked AGENTS.md** (OpenRig always uses it for Codex) → the repo
  pre-commit hook (`system/git-hooks/pre-commit`, installed by agent-project-new) refuses commits containing them.
- **Testing a git hook inside a live seat's worktree** committed that seat's staged file. Test hooks and
  scripts in a throwaway repo/project, never in a seat's worktree.
- **Waves written where the daemon doesn't read them.** Queue wave-map rows (EC-2 in the conventions doc) are
  IGNORED once a mission.yaml exists; the TUI said "no wave declared" while every file check passed. →
  waves in mission.yaml `arrangement.waves` with SPEC ids; `agent-waves-sync`; the check asks the daemon.
- **YAML without the official `metadata:` blocks** → mission readiness "unknown"; **no proofPolicy** → slice
  readiness "legacy"; **no approved-spec-dial** → planning dial unknown. → `agent-project-repair`, setup defaults.
- **Local `main` 100–200 commits behind origin** → the daemon (merge-base against main) showed merged work as
  unmerged, and new worktrees started on an old base. → `agent-repos-sync.timer` fast-forwards every
  project's shared checkout every 5 minutes; the check FAILs when main is behind.
- **No built-commit evidence** (`candidate:<sha>`) → built/merged unknown. → seat `rig` tags builder/test-author
  handoffs with HEAD; `agent-queue-backfill --candidates` for old slices.
- **A context-usage-threshold watchdog on every seat** misfired on 46 seats at once: it measures transcript
  FILE bytes, and long-lived seats (Codex compacts in place) have multi-MB transcripts regardless of live
  context. Don't register it on running seats; use `rig ps --nodes --full` CTX and the lead's judgement, and
  test any new watchdog on ONE seat first.
- **Holding a SQLite write lock across slow work** (GitHub calls inside the transaction) crashed the daemon
  (SQLITE_BUSY). → collect first, write in one short transaction; never write the daemon DB while it's busy
  with long work; restart with `systemctl --user restart openrig.service` if it happens (seats survive).
- **Swapping a seat on a running rig** with `rig import --materialize-only` left it unlaunchable. Change
  topology by editing the spec, `rig down --snapshot`, archive the old record, `rig up` the spec, then
  reroute queue items (`rig queue fallback`) and re-register watchdogs.

## Team conventions every rig carries (rig/template/CULTURE.md)
New projects get these from the template. `agent-project-check` WARNs when an existing rig's CULTURE.md lacks
"Owner decisions"; copy the two sections in from the template.
- **Owner decisions**: dated standing decisions, delegations and approvals. The lead checks them before asking the
  owner and adds each new one there.
- **Operating rules**:
  - owner FYI rows close only after `deliveryOutcome=posted` (decision requests use `--human-intent decision` and stay open);
  - review/QA scratch checkouts go under `~/Projects/<P>.worktrees/`, never `/tmp`, removed in a trap, and tests clean up their `mkdtemp` dirs;
  - proof by catalog id `rig proof show|judge <project-id>:<mission>/slices/<slice>`;
  - never prompt (below);
  - the merge gate (cross-family review, live Jev act band, merge pinned to head; integrator role).

## Never prompt (every project, every machine)
Claude and Codex seats never ask for permission. `agent-project-check` FAILs when any of this is missing, and
`agent-never-prompt-check [--rig R --spec F]` checks it on its own, e.g. on a fresh machine:
- the RigSpec has top-level `permission_policy: builtin:yolo` (`rig/template/*` do; `rig policy apply yolo --spec F`);
- Codex: yolo gives only `-s danger-full-access`, so approval must be `never` too. The seat shim
  (`seat-bin/codex`) adds `-a never`; `~/.codex/config.toml` and `pool-*` profiles say `approval_policy = "never"`,
  `sandbox_mode = "danger-full-access"` (`install.sh` sets them in an existing config);
- Claude: `~/.claude/settings.json` `permissions.defaultMode = "bypassPermissions"` + `skipDangerousModePermissionPrompt`.
A live Codex seat that FAILs was launched before the fix: relaunch it.

## OpenRig's own checks (agent-project-check runs them; run by hand when changing specs)
`rig doctor --spec <rig.yaml>` (live seats match the spec), `rig spec validate` + `rig spec audit` (authoring;
must be clean), `rig agent validate <agent.yaml>` for every role, `rig skill audit` (provenance; our own skills
carry `metadata.openrig`). Spec changes reach running seats only on relaunch/restore — use
`agent-refresh-guidance` for culture/startup text, copy newly declared role skills into the seat's
`.claude/skills` / `.agents/skills` (the managed catalog `rig skill loadout` needs is not set up here).

## Existing project that looks wrong
Run `agent-project-check <P>`, fix FAILs top-down (re-running `agent-project-new` with the same name/rig
repairs the mechanical parts without touching existing files), then hand the lead the remaining
planning items (waves, territories, status) in ONE message.
