---
name: openrig-project-setup
description: >
  Set up, audit or repair a project for an OpenRig build team on this machine the correct way: repo +
  starter kit, workspace (project.yaml, missions, slices), rig, worktrees, wave maps, queue tagging and the
  seat skills. Use when starting a new project or rig, adding a project, when a rig looks idle or its TUI
  Project view is empty/wrong, when waves or missions seem missing, or before dispatching builders wide.
---

# OpenRig project setup (agent-stack)

Two tools do the mechanical work; don't hand-build what they do:

| Tool | Does |
|---|---|
| `agent-project-new --name <P> --rig <short> --github <user> [--team full-stack\|build\|core]` | Repo from the starter kit, held-out dir, private GitHub repo (REST) + protection, workspace with the agent-stack SDLC/wave/git defaults, umbrella catalog + allowlist + scan roots, rig folder, one worktree per seat, `.git/info/exclude`, `rig up`, merge-sweep + daily-summary watchdogs (never duplicated), then the check. Idempotent: re-run it to repair. `--dry-run` shows the plan. |
| `agent-queue-backfill <P> [--apply]` | Adds `project:`, `slice:`/`mission:` tags and `worktree_path=` to a project's EXISTING queue rows (additive, after a DB backup). Use once when the check WARNs about untagged rows from before the seat helper. |
| `agent-project-check <P>` | Read-only audit against OpenRig's references. FAIL = the team or the project views will misbehave; WARN = fix soon. Run it after setup, after the lead's planning, and whenever a rig looks idle. |

Sources of truth: `$OPENRIG_HOME/reference/` — `sdlc-conventions.md` (Part A, DISPATCH DATA EC-1..3),
`wave-sdlc.md`, `product-journey-sdlc.md`, `project-workspace.md`, `planning-dial.md` — and the OpenRig skills
`mission-slice-sop` and `queue-handoff`. Read those, not memory, when in doubt.

## The order
1. `agent-project-new …` (machine prerequisites come from `~/Projects/agent-stack/install.sh`).
2. The owner writes `docs/PLAN.md`; send ONLY the lead: `rig send coord-lead-claude@<rig> "Build docs/PLAN.md"`.
3. The lead + architect produce, before any build dispatch:
   - `features.json` and one mission per area, slices under it (`rig scope …`), every slice SPEC.md with
     `intent`, honest `status`, `depends_on` (inline JSON array; `[]` is a statement), `## Intent`,
     `## Mini-requirements`, `## Proof contract`, a `Territory:` line, `SOFT-AFTER: [ids] — reason` on overlap;
   - ONE wave-map queue row per mission: tags `wave-map,format:wave-map-v1`, body one ```json block
     `{"format":"wave-map-v1","mission":"<m>","waves":[{"id":"w01","slices":[…],"review_model":"two-reviewer-cross-family"}]}`
     — composition only; waves = slices that can build in parallel in disjoint territories; load-bearing
     slices (auth, migrations, payments) get their own wave. A draft from dependency levels is a fine start;
     territory overlap decides the final shape.
4. `agent-project-check <P>` — no FAIL before builders are dispatched wide.
5. Build per wave; the wave review (two non-writer reviewers of different families; drift +
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
- **Swapping a seat on a running rig** with `rig import --materialize-only` left it unlaunchable. Change
  topology by editing the spec, `rig down --snapshot`, archive the old record, `rig up` the spec, then
  reroute queue items (`rig queue fallback`) and re-register watchdogs.

## Existing project that looks wrong
Run `agent-project-check <P>`, fix FAILs top-down (re-running `agent-project-new` with the same name/rig
repairs the mechanical parts without touching existing files), then hand the lead the remaining
planning items (waves, territories, status) in ONE message.
