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
    source_evidence: "install.sh --check and agent-project-check on two live projects; OpenRig 0.5.17 references"
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
| Playwright MCP credentials | test logins go in `~/.config/agent-stack/secrets/playwright.env` (0600) and are typed BY NAME (`browser_type` text `"WITNESS_PASSWORD"`); the MCP (`--secrets`) redacts them as `<secret>NAME</secret>`. Never type a literal password, and never inline an env/credential value (e.g. a token from `.env.local`) in `browser_run_code`/`browser_evaluate` or any tool input: the MCP echoes tool input |
| `agent-heavy build\|browser -- <cmd>` | REQUIRED for every tsc/eslint/vitest/`npm test`/`next build`/Playwright/full-suite run: shared CPU, RAM and concurrency budget (2 slots; memory ceiling 14G build / 8G browser, no swap, 24G for all heavy runs together, over it = killed with exit 137; max runtime 45min build / 30min browser, `--max-runtime` to raise it). Give test runners few workers: `node --test --test-concurrency=4`, `jest --maxWorkers=4` (pytest -n auto and Vitest get 4 from the slot's env). Prefer focused runs. Never wrap a server (`npm start`/`start:*`/`dev`, `next start`, `vite`): refused, `--allow-long` only for a bounded job that looks like one. `agent-heavy status [build\|browser]` shows who holds each slot (seat, cwd, command, age, remaining). Nested calls of the same class run inline in the parent's slot |
| `agent-owner-address [--source]` | the owner's human address seats message (per machine: AGENT_OWNER_ADDRESS, config/owner.env, OpenRig's registered human, else owner@external); new rigs get it in CULTURE.md |
| `agent-dispatch pick-seat --rig R --role ROLE --task "..." [--mission M --slice S \| --exclude-family F]` | ROLE: implementer, reviewer, qa, architect, integrator, test-author, recovery, lead or deputy, or the pod's short name (impl, review, qa, arch, integ, tests, ops); an unknown role is an error listing these. An implementer is never the locked tests' family: give `--mission/--slice` (it reads the slice's `Locked tests: <seat> (<family>)` line or a `locked-test author: <seat>` note in PROGRESS.md or SPEC.md; without a written family, the seat's own, or its name's) or `--exclude-family claude\|codex\|kimi`; the excluded family is filtered in code and named in the output, and an unknown author is said, never guessed. Jev (`intake.seat`) picks the seat from the free seats of that role; act band: dispatch there; otherwise the lead picks and records why |
| `agent-merge-evidence <pr> --mission M --slice S --deploy "..." [--extra-evidence FILE] [--decide]` | prints `{input, history}`: the merge gate's input from exact-head facts (MISSING for any gap; `change` = PR title + the body's first section unless `--change`), and the gate's own earlier runs apart (never copy them into an input; add evidence with `--extra-evidence`); `--decide`: exit 0 live Jev `merge` in the act band; exit 3 NEEDS CONFIRM (merge below the act bar, every gate it checks green; the integrator checks the repo's own gates, then gets a one-line exact-head `confirm <sha>` from the other-family reviewer); exit 1 hold |
| `agent-stuck-check [--rig R] [--dry-run]` | every 10 min: warns a rig's lead when a seat holding work looks looping, rate-limited or stalled (`seat.stuck`); never acts |
| `agent-skills-check` | one line per skill source (ours, OpenRig core and role skills, plugins, Neon, TypeSafe for Codex); the full list with sources: docs/SKILLS.md |
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
   CULTURE.md "Owner decisions" section, each ending with its source (`(owner, Slack HH:MMZ)` or `(owner, via
   operator relay of <ref>)`): check it before asking the owner, and add every new decision there. Only the owner's
   own decisions go there; operator and lead rules, and interpretations, go under "Operator and lead rules".
9. Operating rules (template CULTURE.md, "Operating rules"):
   - send owner FYIs with `--human-intent update`: they are closed automatically once posted (`agent-human-inbox-tidy`,
     every 5 min), so don't reopen them. A row without `--human-intent` counts as a decision and is not auto-closed;
   - decision requests use `--human-intent decision` and stay pending: the owner's Slack reply closes them, and parking or
     claiming one makes that reply a no-op;
   - scratch checkouts go under `~/Projects/<P>.worktrees/`, never `/tmp`, removed in a trap;
   - `TMPDIR` and temp scratch go on disk outside any git repo: each job's own `mktemp -d` directory under the seat root
     `$HOME/.cache/<rig>-tmp/<seat>`, removed by that job's trap (never the shared root); never `/tmp` (a RAM disk
     here) and never inside a worktree (tests take a dir under a repo for a checkout); example in CULTURE.md;
   - visual proof for the owner: ONE file per owner update row, `--evidence-ref <absolute path>` (.png/.jpg/.gif/.webp,
     .mp4/.webm/.mov or .pdf, at most 50 MiB), uploaded into that message's Slack thread. For a witness pass, a
     finished user-visible feature or a fix for a bug the owner reported, not every step; the lead sends it, QA and the
     witness hand it the path. Saved under `$HOME/.cache/<rig>-tmp/<seat>/proof/` (not a job's temp dir: the daemon
     reads it when it posts), never `/tmp` or a repo; demo or fictional data only, never secrets, tokens or real
     client data on screen;
   - judge proof as `rig proof judge <project-id>:<mission>/slices/<slice>`;
   - merge = cross-family review + live Jev act band + merge pinned to head.
10. Done needs an agent witness: a fresh agent uses the deployed feature through the real UI and records
    `agent-witnessed (YYYY-MM-DD, by <agent>, <model>)` with evidence. Every wave with user-facing slices ends with a
    W witness slice (`rig/template/witness-slice/`) that gates the next wave. Only a docs/infra-only wave may skip it,
    with `no-witness: <reason>`. Tests, merges and deploys are not witnesses.
11. OpenRig upgrades are operator windows (`docs/UPGRADE.md`), raised weekly by `openrig-update.timer`; never ad hoc. Owner delegations/standing approvals go into the rig CULTURE.md.

## Onboarding a project (the kernel operator)
"Onboard <repo or project>" to the operator runs the `project-onboarding` skill end to end: intake (only what can't be
derived), env isolation, `agent-project-onboard <answers.env>` (dry run, then `--apply`), the owner's plan, CULTURE
decisions and specifics, the lead brief, the plan review, `agent-project-check`, and a report to the owner. Answers file
and lead-brief templates: `rig/template/onboarding/`. install.sh points the operator at the skill
(`system/operator-guidance`).

## Workflow skills (every rig, by default)
Six of our skills set how a team verifies and writes. The rig CULTURE "Workflow skills" section and each role text say
who uses which, and when:
- `verification-guide`: the architect's `docs/VERIFY.md` feature map; QA and witnesses follow it.
- `bug-review-board`: QA's real-user pass (browser for web, command or HTTP API otherwise); bugs as queue rows to
  the lead; the ship YES/NO recorded with `rig proof add` and passed to the Jev merge gate.
- `blast-radius`: what a diff breaks outside its files, with the key safety fact proven by running code.
- `review-lenses`: the lenses a cross-family review applies, and how it sorts findings.
- `unslop`, `technical-writing`: plain, specific text in every PR, SPEC, comment, queue body and owner message.
A new rig gets them from `agent-project-new`. For a running rig: copy the section from `rig/template/CULTURE.md` into
the rig's CULTURE.md, then `agent-refresh-guidance <P> --apply`. `agent-project-check` WARNs while the rig's CULTURE.md
lacks the section or the skills aren't installed. It can't see whether running seats re-read their instructions: the
lead confirms that with each seat.

## Operating a running fleet (operator runbook)
- **Relaunch a seat, only when it is idle.**
  - Codex: `C-u` (clear the composer), `/quit`, Enter. Claude: `/exit`.
  - Kill the tmux session only if the seat dropped to a bare shell.
  - Then `rig launch <rigId> <pod.member>`, with the rig ID (from `rig ps --json`), not its name.
- **Verify it resumed its OWN conversation**, not a fresh one:
  - Codex: the seat's codex process shows `resume <thread>` in `/proc/<codex pid>/cmdline`, and that thread's session
    file is large and carries the seat's cwd.
  - Claude: its command line shows `--resume <session-id>`.
  - A UUID in the pane's child shell is OpenRig's tmux-send helper, not the thread.
- **Retire and restore a seat:**
  1. `rig seat stop`. If the seat is a claimed session: `/quit`, then `rig unclaim`, then kill the now-empty session.
  2. Restore it later with `rig launch <rigId> <pod.member>`.
- **Playwright secrets:** the MCP reads `--secrets` once, when it starts.
  - Add every entry a seat will need first, then relaunch it once.
  - Append to `~/.config/agent-stack/secrets/playwright.env`, never rewrite it, and prefix names with the project
    (`APP_WITNESS_PASSWORD`).
- **Playwright network and console listings go to a file, never the transcript.** Runtime tokens (session JWTs,
  `?token=`, signed URLs) aren't covered by `--secrets`. The credential guard allows `browser_network_requests`,
  `browser_network_request` and `browser_console_messages` only with `filename` set to an absolute path in
  `~/.local/state/agent-stack/playwright-mcp/net/<seat>/` and named by what it writes (`requests-…`, `request-…`,
  `part-…`, `console-…`); it protects that dir like a credential file. Read it with
  `agent-net-summary <file>` (method, host, path, status; queries and headers dropped, token-like path segments masked).
- **Credentials never go to a seat's output** (it is the transcript). Seats' `neon`/`vercel` run through
  `seat-bin/credguard`: credential-printing commands need `--output-file <path>` (0600) and use the values by name
  (docs/PROJECT-ENV.md). `agent-credguard-check` shows which running seats are guarded (Claude seats: after a relaunch).
- **Vercel protection bypass is a secret, keys included.** Ask `agent-vercel-protection-status <project>` (yes/no and
  counts). `vercel api …/projects…` runs only with `--output-file ~/.local/state/agent-stack/vercel/<seat>/x.json`;
  anything naming `protectionBypass` is refused, and so is inline `node -e`/`python -c` code that reads a protected file.
- **Rebuild handovers read only the seat's declared chain**: `<topology.root>/rigs/<rig>/seats/<member>/RECAP.md`,
  then LEARNED.md, the compaction restore packet and superseded recaps. A packet in shared-docs is never read.
  - The seat publishes its packet with `agent-seat-recap write <packet> [--learned <lessons>]` (OpenRig's
    `rig context recap-write` underneath); `agent-seat-recap show --seat <member>@<rig>` shows what a rebuild would get.
  - Hand over with `agent-seat-handover <seat> --source rebuild --reason …`: the CLI gives up after 5 s ("outcome
    UNKNOWN") while the daemon completes, so the wrapper polls `rig seat status` until this run's handover is
    recorded. Exit 0 complete, 1 failed, 3 unknown, 4 complete but a parked row's wake couldn't be re-armed. On
    unknown never retry: that makes a second successor.
  - OpenRig stops every watchdog job the retiring occupant registered, park timers (`rig queue block --wake-after`)
    included. The wrapper records the seat's parked rows and their wakes first and, once the handover is complete,
    re-parks each row that is still blocked, still the seat's, and has no live wake (same blocker, same interval),
    printing each one. It never adds a second wake to a row that still has one; a row it can't read is listed. `agent-seat-handover <seat> --wakes` lists them and changes
    nothing.
- **Slack attachments** need the app's bot scopes `files:write` (proof seats send) and `files:read` (files the owner
  sends, e.g. a screenshot in a reply); `rig slack manifest` has both, an older app adds them and is reinstalled.
  `rig slack verify` checks only its required scopes, which by default leave both out, so set them once:
  `rig slack setup --required-scopes chat:write,channels:history,channels:read,files:read,files:write`. Then
  `openrig-slack-upload-check` (dry: patch 141 in, channel, token present) and `openrig-slack-upload-check --live`
  (a 1x1 PNG into the channel; `--file <abs .mp4>` for video). A failure prints only Slack's code, an HTTP status or
  a fixed category. A row's text without its file means the daemon logged "attachment missing": read its log line.
- **`rig ps` ATTN `user_prompt_submit`** on a seat that is working is not a stuck seat: it is mid-turn. Check its pane
  before acting.
- Never stop or restart `openrig.service` or `openrig-tmux.service` while rigs run. Restart the daemon with
  `openrig-daemon-cycle` (docs/incidents/2026-09-29-unit-stop-killed-seats.md).

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
