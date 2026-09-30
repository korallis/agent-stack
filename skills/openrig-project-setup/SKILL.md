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
| `agent-project-new --name <P> --rig <short> --github <user> [--team full-stack\|build\|small\|core]` | Repo from the starter kit, held-out dir, private GitHub repo (REST) + protection, workspace with the agent-stack SDLC/wave/git defaults, umbrella catalog + allowlist + scan roots, rig folder, one worktree per seat, `.git/info/exclude`, `rig up`, merge-sweep + daily-summary watchdogs (never duplicated), then the check. Idempotent: re-run it to repair. `--dry-run` shows the plan. **Existing repo** (commits + origin): adopted as is, and its trunk (origin/HEAD, e.g. `master`) is used for worktrees, seat context and PRs. The kit goes to `<P>-work/starter-kit/` (adopting it is the lead's first slice, by PR). The repo's own GitHub protection or ruleset is kept. `.env.local` is linked into each seat. When the trunk isn't `main`, a local `main` mirrors origin/<trunk> for OpenRig's "merged" check (agent-repos-sync keeps it current; a pre-push hook keeps it off the remote). |
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
The kernel operator runs all of this from one request with the `project-onboarding` skill and `agent-project-onboard`
(an answers file, dry run first). The steps below are what it does, and what to check by hand.

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
4. The architect writes `docs/VERIFY.md` (the `verification-guide` skill) before the first wave: the feature map QA,
   the bug review board and witnesses follow. The team's other workflow skills (`bug-review-board`, `blast-radius`,
   `review-lenses`, `unslop`, `technical-writing`) are in the rig CULTURE "Workflow skills" section and the role texts
   from day one.
5. `agent-project-check <P>` — no FAIL before builders are dispatched wide (it WARNs when the CULTURE lacks the
   Workflow skills section or a seat can't see those skills).
6. QA and the merge owner `rig proof judge` each proof item after a pass (that is the TUI's readiness).
7. Build per wave; the wave review (two non-writer reviewers of different families; drift +
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
  with long work; restart only the daemon with `openrig-daemon-cycle` if it happens. Never stop or restart `openrig.service` or
  `openrig-tmux.service` while rigs run; seats live in the latter's tmux server.
- **Swapping a seat on a running rig** with `rig import --materialize-only` left it unlaunchable. Change
  topology by editing the spec, `rig down --snapshot`, archive the old record, `rig up` the spec, then
  reroute queue items (`rig queue fallback`) and re-register watchdogs.

## Team conventions every rig carries (rig/template/CULTURE.md)
New projects get these from the template. `agent-project-check` WARNs when an existing rig's CULTURE.md lacks
"Owner decisions", or when its Operating rules lack the `agent-heavy` rule; copy them in from the template, then
`agent-refresh-guidance <P> --apply` on a running rig.
- **Owner decisions**: dated standing decisions, delegations and approvals. The lead checks them before asking the
  owner and adds each new one there.
- **Operating rules**:
  - owner FYIs use `--human-intent update` and are auto-closed once posted (`agent-human-inbox-tidy`; an unset intent counts as a decision); decision requests use `--human-intent decision` and stay pending (never parked or claimed: the Slack reply closes only a pending row);
  - review/QA scratch checkouts go under `~/Projects/<P>.worktrees/`, never `/tmp`, removed in a trap, and tests clean up their `mkdtemp` dirs;
  - proof by catalog id `rig proof show|judge <project-id>:<mission>/slices/<slice>`;
  - heavy runs (tsc, eslint, vitest/jest, `npm test`, `next build`, Playwright, full suites) only through
    `agent-heavy build|browser -- <cmd>`, preferring focused runs (2026-09-29: load 101 on 32 cores from parallel
    suites stalled the OpenRig daemon);
  - never `pkill -f`/`killall` by pattern (it matches other seats' command lines); stop your own processes by PID;
  - research -> plan -> implement for every slice, feature, fix and wave (`## Research` / `## Plan` in the slice
    PROGRESS.md before the first code commit; the section "Research, plan, implement"; agent-project-check WARNs
    without it);
  - never prompt (below);
  - the merge gate (cross-family review, live Jev act band, merge pinned to head; integrator role).

## Adopting an existing repo (worked example: fortis-secure, trunk `master`)
`agent-project-new` detects an existing repo (commits + origin) and adopts it as it is:
- **Trunk:** `origin/HEAD` (e.g. `master`). Worktrees start from `origin/<trunk>`; PRs target the trunk; `@TRUNK@` fills
  the seats' startup context and the CULTURE specifics.
- **Main mirror:** OpenRig judges "merged" against a local ref named `main`. When the trunk isn't `main`, the shared
  checkout keeps `refs/heads/main` = `origin/<trunk>`. It's only a ref: never checked out, never pushed (a pre-push
  hook refuses). `agent-repos-sync` keeps it current; `agent-project-check` FAILs a stale mirror.
- **Starter kit:** never copied into the working tree. It goes to `<P>-work/starter-kit/`; adopting it (merged with the
  repo's own AGENTS.md, README, .gitignore, Playwright config) is the lead's first slice, as a PR.
- **Merge gate:** the repo's own gate is adopted, not replaced.
  - `agent-project-new` keeps an existing ruleset or branch protection (it adds the kit's only when there is none).
  - Record the required checks and the merge path in CULTURE specifics. Fortis: ruleset checks `verify` +
    `qa-evidence`, squash only, and a `jev-approved` label that arms GitHub auto-merge.
  - The merge owner applies such a label only after the cross-family review and the live Jev `review.merge_gate` act
    band on the exact head. Never merge around the ruleset.
- **Production deploys on merge:** if every merge to the trunk auto-deploys, say so in CULTURE specifics.
  - Every PR must be safe to ship on merge: backward-compatible migrations, nothing half-finished.
  - The witness (and a tester's re-test) runs on the production URL once the deploy is Ready.
- **Environment:** seats get a development environment of their own (docs/PROJECT-ENV.md): a dev database branch and
  a dev file store in `.env.local`, linked into every worktree. Production and preview env files stay with the owner,
  outside the repo.
- **CULTURE specifics template lines** for such a repo: trunk and mirror; package manager (e.g. bun, heavy commands via
  `agent-heavy build -- bun …`); required checks and merge path; databases and env (which branch, which store, what
  seats never touch); deploys (what merges ship, where the witness runs).

## Project environments (full guide: docs/PROJECT-ENV.md)
Seats run with permission checks off, so they only ever get development credentials:
- Pull env per environment (`vercel env pull .env.local --environment=development`). Production and preview files go
  in an owner-only dir outside the repo, never into a worktree.
- The database gets a dev branch for the seats. **Reset the role password on the child branch**: it inherits the
  parent's, so without the reset the dev URL also opens production. Previews get a branch per deployment.
- Files (e.g. Blob) get a store per environment. Seats never touch production data.
- Only `<repo>/.env.local` is linked into worktrees (agent-project-new does it), never `.env.*.local` or `.env.production*`.
- Verify by hash, never by printing a value: hash the dev and production database PASSWORDS (not only the URLs; a
  different host can hide an inherited password). docs/PROJECT-ENV.md has the check.
- Expect Vercel to rewrite things:
  - saving a store connection re-issues its tokens as Sensitive: re-pull, and prove the first deploy still uploads;
  - `vercel blob create-store` rewrites `.env.local`: re-check the database and store it points at.
- Write the arrangement into CULTURE specifics (which branch and store seats use; seats never look for, copy or
  request production or preview env files).

## Agent witness (default for every project)
Done = acceptance tests + a FRESH agent witnessing the feature end to end through the real UI on the deployed
environment, recorded as `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)` with evidence. Tests, merges and deploys
are not witnesses. Every wave with user-facing slices ends with a W witness slice: copy `rig/template/witness-slice/`
into `missions/<m>/slices/<NN>-<wave>-witness/` (`witness: true`, depends on the wave's slices) as the wave's last
member (or its own follow-on wave `<wave>w`). It gates the next wave; the mission's last-wave W is also the mission
gate. A docs/infra-only wave says `no-witness: <reason>` in mission.yaml instead. `agent-project-check` WARNs for each
open wave without one (wave ids are global, so members are merged across missions).

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
