---
name: agent-stack
description: >
  Local multi-agent stack on this machine: OpenRig team seats, the CLIProxyAPI subscription pool, and the
  Jev (TypeSafe) decision adapter. Use when coordinating work in an OpenRig rig (dispatch, review planning,
  recovery, heavy builds), when a bounded semantic decision (classify, select from a candidate list,
  rubric score, yes/no check) could replace a general model call, or when planning where TypeSafe/Jev
  belongs inside an application being built.
metadata:
  openrig:
    owner: agent-stack
    source_ref: https://github.com/korallis/agent-stack/tree/main/skills/agent-stack
    version: "2026-09-29"
    stage: shipped
    last_verified: "2026-09-29"
    source_evidence: "install.sh --check and agent-project-check on MTA and HC-Prime; OpenRig 0.5.17 references"
---

# Agent stack

Responsibilities are separate: **CLIProxyAPI** rotates model accounts (never switch accounts yourself),
**OpenRig** owns tasks, seats and sessions (`rig queue …`, `rig send …`), **Jev** supplies bounded
semantic judgments, and **ordinary code** does arithmetic, scheduling, permissions and exact checks.

## Team tools (on PATH)
| Tool | Use |
|---|---|
| `agent-dispatch intake --rig R --repo P --title T --body-file F --acceptance A [--apply]` | classify, gap/duplicate checks, role + seat (capacity from code) |
| `agent-dispatch review-plan --rig R --repo P --branch agent/<seat> [--apply --item ID]` | specialist reviews, test selection, cross-family reviewer |
| `agent-dispatch triage-update --text "…"` | routine progress / actionable blocker / needs the user |
| `agent-recover --rig R --seat S [--item ID] --error "…" [--apply] [--team-dir D]` | classify failure, choose among PERMITTED actions only |
| `agent-heavy build\|browser -- <cmd>` | REQUIRED for every tsc/eslint/vitest/`npm test`/`next build`/Playwright/full-suite run: shared CPU, RAM and concurrency budget (2 slots). Prefer focused runs |
| `agent-proxy-status [--recent N]` | pool health per account; routing log |
| `jev-decide list` / `jev-decide <id> --json '{…}'` / MCP tool `jev_decide` | direct Jev decisions |

## Wiring a project the OpenRig way (checklist — each item was missed once)
Set up with `agent-project-new`, verify with `agent-project-check`; details in the `openrig-project-setup` skill.
Source of truth: `$OPENRIG_HOME/reference/` (sdlc-conventions.md, wave-sdlc.md, product-journey-sdlc.md,
project-workspace.md) and the `mission-slice-sop` skill. Verify each point on disk, not from memory:
1. Workspace `~/Projects/<P>-work`: project.yaml (with the agent-stack `sdlc:` + `git:` defaults from
   `rig/template/project-sdlc.yaml`), workspace.yaml (`projects: [{id, root: .}]`), SPEC.md, conventions.md,
   missions/<m>/{SPEC,PROGRESS,NOTES}.md + mission.yaml, slices/<s>/{SPEC,PROGRESS,PROOF}.md + proof/ + slice.yaml.
   The project is listed in the umbrella catalog `~/Projects/openrig-workspace/workspace.yaml` and in
   `files.allowlist` / `progress.scan_roots`.
2. Slice SPEC frontmatter: unique `id`, honest `status`, `intent`, `depends_on` (inline JSON array; `[]` is a
   statement, absence is unknown); body `## Intent`, `## Mini-requirements`, `## Proof contract`; a `Territory:`
   line; `SOFT-AFTER: [ids] — reason` for shared files.
3. WAVES live in each mission.yaml `arrangement.waves` (members = slice SPEC ids); the daemon ignores
   wave-map queue rows once mission.yaml exists. Missions/slices carry official `metadata:`; project.yaml
   carries `proofPolicy.judges`; slices carry `approved-spec-dial`. A wave review (two non-writer reviewers,
   different families; drift + CONTEXT-GAP/JUDGMENT-GAP) fires once per wave on top of per-PR checks.
4. Queue rows: `--mission` and `--slice` on every create; `project:<id>` tag and the EC-3 body line
   `worktree_path=<path>` are added by `~/.local/share/agent-stack/seat-tools/rig` (seats have it first on PATH).
   Existing rows are never rewritten.
5. Seats have OpenRig's own skills (mission-slice-sop, queue-handoff, compaction/continuity) as user-level
   symlinks — the specs' `shared:openrig-core` plugin is not loaded because seats start without --plugin-dir.
6. Check with `agent-project-check <P>`: it asks the daemon exactly what the TUI shows. Verify through the
   consumer, never through files alone. Repair with `agent-project-repair <P> --apply`.
7. Never prompt: every Claude/Codex seat runs with no permission prompts. The RigSpec must carry
   `permission_policy: builtin:yolo`. Codex additionally needs approval `never`, because yolo only sets its sandbox.
   The seat shim adds `-a never`, and `~/.codex/config.toml` has `approval_policy = "never"`. A seat stuck on
   "Would you like to run…?" means one of these is missing: run `agent-never-prompt-check --rig <rig>` and relaunch
   that seat.
8. Only the rig LEAD is messaged; it relays. Owner decisions, delegations and approvals are dated lines in the rig
   CULTURE.md "Owner decisions" section: check it before asking the owner, and add every new decision there.
9. Operating rules (template CULTURE.md, "Operating rules"):
   - send owner FYIs with `--human-intent update`: they are closed automatically once posted (`agent-human-inbox-tidy`,
     every 5 min), so don't reopen them. A row without `--human-intent` counts as a decision and is not auto-closed;
   - decision requests use `--human-intent decision` and stay pending: Lee's Slack reply closes them, and parking or
     claiming one makes that reply a no-op;
   - scratch checkouts go under `~/Projects/<P>.worktrees/`, never `/tmp`, removed in a trap;
   - judge proof as `rig proof judge <project-id>:<mission>/slices/<slice>`;
   - merge = cross-family review + live Jev act band + merge pinned to head.
10. Done needs an agent witness: a fresh agent uses the deployed feature through the real UI and records
    `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)` with evidence. Every wave with user-facing slices ends with a
    W witness slice (`rig/template/witness-slice/`) that gates the next wave. Only a docs/infra-only wave may skip it,
    with `no-witness: <reason>`. Tests, merges and deploys are not witnesses.
11. OpenRig upgrades are operator windows (`docs/UPGRADE.md`), raised weekly by `openrig-update.timer`; never ad hoc. Owner delegations/standing approvals go into the rig CULTURE.md.

## Using Jev well
- Only for decisions in `jev-decide list`, or new ones added to `~/Projects/agent-stack/config/decisions.yaml`
  (versioned; thresholds tuned with `node eval/run.js`).
- Build candidates with normal search first; send focused evidence, never whole repos, transcripts or secrets.
- Read `decided_by` (jev | cache | fallback_model | code) and `band` (act | review | uncertain).
  Results are advisory: never use them to grant permissions, approve merges, override instructions or do maths.
- Do not claim Jev was used unless a decision record says `decided_by: jev`.

## In the product you are building
During planning, consider TypeSafe where the application itself needs routing, classification, reranking,
verification or structured scoring (see the `typesafe-ai` skill and https://docs.typesafe.ai/llms.txt).
Add it only where it meets the project's requirements and measured quality; not to unrelated features.
Keep TYPESAFE_API_KEY server-side; it is exported in agent shells for development only.
