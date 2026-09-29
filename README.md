# agent-stack

**Write a plan. Get working, user-tested software back.**

agent-stack turns one Linux computer into a full software team made of AI coding agents. You describe what you
want in a plain plan document. The team breaks it into features, writes the tests first, builds, checks the work
the way a real person would use it, reviews it, and merges it. You are asked for one approval of the feature list,
for sign-off on risky changes, and for decisions only you can make. Everything else runs on its own, for hours or
days, across as many projects as your subscriptions allow.

It is built from existing tools, glued together and configured so they work as one team:

| Tool | What it does here |
|---|---|
| [OpenRig](https://www.npmjs.com/package/@openrig/cli) | Runs the team: each agent is a "seat" with a role, a task queue, handoffs, reminders and one merge owner |
| Claude Code | The workspace for seats running Anthropic models (and Kimi) |
| Codex CLI | The workspace for seats running OpenAI GPT-6 models |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Pools your subscriptions so work moves to another account when one hits its limit |
| [TypeSafe Jev](https://typesafe.ai) | Makes fast, small decisions: which seat should do this task, how risky is this change, should this merge |
| [Superpowers](https://github.com/obra/superpowers) | Gives every builder a disciplined method: plan, write a failing test, build, verify |
| Playwright | A real browser the agents use to test the app like a person, on desktop and phone sizes |

## How a project goes

1. **You write the plan** in `docs/PLAN.md`: who uses it, what they need to do, the rules, what's out of scope.
2. **The architect turns it into a feature list** where every acceptance criterion is something a person does and
   sees ("choosing a full date shows 'This date is full'"). You get a desktop notification and approve it once.
3. **Tests are written first, by a different AI.** For each feature, a test author from the other model family
   writes browser journeys that prove it works for a person. They are locked: the builders cannot change them.
4. **The lead hands each feature to the best builder**, chosen with Jev from the idle seats. Up to about nine
   features are built at the same time.
5. **A QA seat uses the finished feature by hand** in a real browser, tries the usual mistakes people make, and
   attaches screenshots.
6. **A reviewer from the other model family reviews it** with the plan and criteria in hand, and posts findings;
   the builder fixes them. Risky changes (logins, payments, data deletion, database changes) also get a third review
   and wait for your OK.
7. **The merge owner merges it** only when CI, the locked tests, a hidden set of extra tests, QA, review and Jev all
   agree. Two failed attempts send the feature to the strongest model (GPT-6 Astra).
8. **You get a daily summary**, and a final report when every feature is done.

## Who does what (the full-stack team, 27 seats)

Every seat is pinned to the model that published benchmarks and Jev picked for its job. Most of the work runs on
GPT-6 Sol; Claude Opus 5.5 is used where it is strongest: orchestrating the team (its 1M-token context holds the
whole backlog), planning, user interfaces, big migrations and reviewing Codex's work.

| Seat | How many | Model | What it does |
|---|---|---|---|
| Lead | 1 | Claude Opus 5.5 (1M context) | The orchestrator: keeps the whole backlog in mind, asks for your approval, hands out work, tracks progress, writes the daily summary |
| Deputy | 1 | GPT-6 Sol | Helps the lead dispatch, chase and keep notes |
| Architect | 1 | Claude Opus 5.5 | Turns your plan into features with acceptance criteria a person can check |
| Test authors | 3 | 2 × Opus 5.5, 1 × GPT-6 Sol | Write the locked browser tests before a feature is built (always the other family from its builder) |
| Builders | 8 | GPT-6 Sol | Build features, unit tests and routine changes |
| UI builders | 2 | Claude Opus 5.5 | Build screens and interfaces, and large database or code migrations |
| Escalation builder | 1 | GPT-6 Astra | Takes over any feature that failed twice; kept free for that because its quota is small |
| QA testers | 3 | GPT-6 Sol | Use each feature by hand like a real person and record screenshots |
| Reviewers | 4 | 2 × Opus 5.5, 2 × GPT-6 Sol | Opus reviews GPT's work and GPT reviews Claude's: different models catch different bugs |
| Third reviewer | 1 | Kimi K3 (1M context) | Extra review of risky changes; reads very large amounts of code at once |
| Merge owner | 1 | GPT-6 Sol | The only seat that merges; checks every gate first |
| Recovery | 1 | GPT-6 Sol | Unsticks stalled seats, broken builds and merge conflicts |

Claude Fable 5.1 stands in for Opus 5.5 when Opus is rate-limited. Smaller projects can use `build.yaml`
(14 seats), and `fallback-codex.yaml` keeps working with no Claude account at all.

## What gets installed

Everything is listed with versions in [`config/tools.md`](config/tools.md). In short:

- **Programs:** OpenRig, CLIProxyAPI, Claude Code, Codex CLI, Node.js (via mise), ripgrep and fd for fast search,
  the TOON CLI for compact prompts, and Playwright with Chromium.
- **In every seat:** the **Superpowers** plugin (for Claude Code and for Codex) for disciplined plan → test → build →
  verify work; the **TypeSafe** skill; this repo's **agent-stack** skill; OpenRig's own skills.
- **Tools the agents can call:** **Jev** (fast typed decisions) and a **Playwright browser** (so QA can use the app
  like a person), both in Claude Code and Codex.
- **Background services:** the subscription pool, the OpenRig daemon, health checks, usage logging, a sign-in
  failure alert, a quota warning at 80%, and the daily OpenRig updater.

## What you need

- A Linux computer with systemd (built and tested on Arch/Omarchy; a 16-core, 64 GB machine runs several teams).
- Subscriptions, logged in through the proxy: at least one ChatGPT Pro (Codex) and one Claude Max plan; Kimi is
  optional. More accounts give more capacity and smoother failover.
- A GitHub account, and a [TypeSafe](https://typesafe.ai) key for Jev.

## Install

```bash
git clone https://github.com/korallis/agent-stack ~/Projects/agent-stack
cd ~/Projects/agent-stack && ./install.sh
```

The installer is safe to re-run and never overwrites your secrets, logins or existing configs. When it finishes it
lists the few things only you can do:

```bash
gh auth login
agent-login claude claude-a        # once per Claude subscription (claude-b, …)
agent-login codex codex-a          # once per ChatGPT subscription
agent-login kimi kimi-a            # optional
# paste your TypeSafe key into ~/.config/agent-stack/secrets/typesafe.env
```

`./install.sh --check` shows what is missing at any time.

## Start a project

One command sets up a project correctly, and a second checks it:

```bash
agent-project-new --name MyProject --rig myproj --github <your-github-user>   # repo, workspace, team, worktrees, GitHub
agent-project-check MyProject                                                 # is everything wired the way OpenRig expects?
```

`agent-project-new` copies the starter kit into the repo (the locked-test folder, the CI checks that enforce it, a
Playwright setup), creates a private GitHub repo with branch protection, gives the project its own OpenRig workspace
with our build defaults (waves, review steps, merge to main), creates one git worktree per seat, starts the
27-seat team and its reminders. It never overwrites existing files, so running it again repairs a project.
`--dry-run` shows what it would do. Then write `docs/PLAN.md` and:

```bash
rig send coord-lead-claude@<rig> "Build docs/PLAN.md"
```

The lead has the architect turn the plan into features, missions, slices and **waves** (groups of slices that
can be built at the same time without touching the same files). Run `agent-project-check` again once you have
approved the feature list: nothing should say FAIL before the builders start. Agents doing this follow the
`openrig-project-setup` skill, which also lists every mistake this setup has made before and what now prevents it.

From then on you only hear from the team through desktop notifications: the feature list to approve, risky changes
to OK (unless you have given standing approval in the project's `rig/CULTURE.md`), blockers, and the daily summary.

## Everyday commands

```bash
rig ps                                   # which teams are running
rig ps --nodes --rig <rig>               # what each seat in a team is doing
rig send <seat>@<rig> "message"          # talk to a seat, e.g. the lead
rig queue list -a -A                     # who owns which task
agent-project-check <Project>            # is a project wired correctly (waves, slices, tags, skills)?
agent-refresh-guidance <Project> --apply # after editing a rig's CULTURE.md: update running seats' instructions
agent-project-repair <Project> --apply   # fix anything agent-project-check flags
rig down <rig> --snapshot                # stop a team (resume later with: rig up <rig>)
agent-proxy-status                       # how the subscription pool is doing
claude-pool                              # your own Claude Code session through the pool (incl. Kimi models)
openrig-update --check                   # is OpenRig up to date? (+ are local patches ready for the new version)
```

## Several projects at once

Each project gets its own team, its own worktrees (`~/Projects/<Name>.worktrees/`) and its own OpenRig workspace
(`~/Projects/<Name>-work`); seats find their workspace automatically from those names. OpenRig itself points at
`~/Projects/openrig-workspace`, whose `workspace.yaml` lists every project, so the OpenRig TUI's **PROJECTS** view
shows each project's missions and slices. Add projects whenever you
like. The shared limit is subscription quota, not the computer: `cliproxy-quotawatch` warns you at 80% of any
account's 5-hour or weekly allowance, and loudly when a whole provider is nearly used up. Add another subscription
with `agent-login` and the pool uses it straight away.

## Staying up to date

- **OpenRig** updates itself from upstream: a daily check upgrades it only when no project team is running,
  re-applies this setup's adjustments, re-validates every team spec, rolls back if anything fails, and records the
  new version in `config/versions.env`.
- Everything that makes this setup what it is lives in this repo, outside OpenRig's own files, so upgrades cannot
  overwrite it. CLIProxyAPI is updated by changing its version in `config/versions.env` and re-running the installer.

## Read before you use it

- **Pooling consumer subscriptions through a proxy may break your providers' terms.** Anthropic's Claude Code terms
  explicitly prohibit it. If you pool anyway, that is your decision and your risk. `cliproxy-authwatch` alerts you
  if an account starts failing to sign in, and `fallback-codex.yaml` lets you keep working without Claude.
- **Seats run with permission checks off** so they can work unattended. Run this on a machine and accounts you are
  comfortable letting agents use, and never give seats production or cloud-admin credentials.
- **Quality comes from verification, not from the models.** The locked tests encode what "done" means, so read the
  feature list carefully before you approve it.

## Technical reference

### Where things are

- Secrets (0600, never in git): `~/.config/agent-stack/secrets/{cliproxy.env,typesafe.env}`; OAuth tokens in `~/.cli-proxy-api/*.json`.
- **Transcript capture:** every 15 seconds, 400 lines (`transcripts.poll_interval_seconds`, `transcripts.lines`; set by
  `install.sh`). OpenRig's 2s/1000-line default across ~90 seats kept the daemon's event loop busy. `openrig-daemon-cycle`
  starts the daemon without the `OPENRIG_TRANSCRIPTS_*` overrides that seats inherit from tmux.
- **Seats never depend on the daemon unit.** Every seat lives in the tmux server of `openrig-tmux.service`, not in
  `openrig.service`. tmux ties each pane to the unit its server runs in, which is how `systemctl stop openrig.service`
  once stopped every seat. Restart the daemon with `openrig-daemon-cycle` (the health check does too), never with
  systemctl. `openrig-tmux-adopt` moves an older server out of `openrig.service` without stopping seats.
- Proxy config `~/.cli-proxy-api/config.yaml`; services `cliproxyapi`, `openrig`, `openrig-tmux` and timers `cliproxyapi-health`, `cliproxy-usage`, `openrig-health`, `cliproxy-authwatch` (alerts on repeated 401/403 for one account), `cliproxy-quotawatch` (warns at 80% of any 5-hour or weekly allowance, critical when a whole provider is past it), `openrig-update` (weekly: raises an "upgrade window due" queue item for operator-agent@kernel; never upgrades by itself, see docs/UPGRADE.md) (user units, linger on).
- Pinned versions: `config/versions.env`.
- Jev decisions (single source of truth): `config/decisions.yaml`; evaluation: `eval/` (`node eval/run.js`); unit tests: `node --test 'test/*.test.js'`.
- Decision log: `~/.local/state/agent-stack/jev.sqlite` + `jev-decisions.jsonl` (state hash only, no raw payloads).
- Routing log: `~/.local/share/agent-stack/logs/proxy-usage.jsonl` (account, model, status, latency, quota; no content).
- Per-project team notes: `<repo>/.team/` (REQUIREMENTS, DECISIONS, plans, handoffs, incidents; git-excluded).
- Snapshot of non-secret system files: `system/` (secrets redacted).

### How seats get their configuration (launch and restart alike)

- **Claude seats:** OpenRig sets `OPENRIG_NODE_ID`; `~/.config/agent-stack/env.sh` (sourced by `~/.bashrc` before its
  interactive guard) then exports `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` for the pool, pins model aliases, and sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Your own `claude` keeps direct login and claude.ai connectors.
- **Codex seats:** global `~/.codex/config.toml` (pool provider, key via `auth.command`) plus the seat-only shim
  `~/.local/share/agent-stack/seat-bin/codex` (first on the OpenRig daemon's PATH): `--no-daemon`, slug display names,
  analytics/update checks off, and makes Codex the terminal foreground group.
- **Never prompt (YOLO):** every Claude and Codex agent runs without permission prompts, on every project and machine.
  - RigSpecs carry `permission_policy: builtin:yolo`: each one you write, and all 13 built-in presets (re-applied by
    `openrig-upgrade`). OpenRig ignores the ambient `OPENRIG_YOLO`. That gives Claude seats `--dangerously-skip-permissions`.
  - It gives Codex seats only a sandbox (`-s danger-full-access`), not an approval policy. So Codex also needs approval
    `never`, or seats stop at "Would you like to run the following command?". The seat shim adds `-a never` to every
    Codex seat launch, and `~/.codex/config.toml` (plus the `pool-*` profiles) sets `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"` for everything else. `install.sh` fixes those two keys in place in an existing
    config (backup first).
  - `~/.claude/settings.json` sets `permissions.defaultMode = "bypassPermissions"` for every Claude session.
    `skipDangerousModePermissionPrompt` stops the bypass warning dialog from exiting seats.
  - Verify on a new machine or project with `agent-never-prompt-check [--rig <rig> --spec <rig.yaml>]`
    (`agent-project-check` runs it too). Relaunch Codex seats that report FAIL.
- **Jev:** MCP server `jev` registered at user scope in both harnesses (runs outside the Codex sandbox); `TYPESAFE_API_KEY`
  exported in shells; skills `typesafe-ai` and `agent-stack` in both harnesses.

### Local fixes for OpenRig 0.5.17 + Codex 0.157 (no fork)

| Symptom | Cause | Fix |
|---|---|---|
| Messages to Codex seats never submitted | OpenRig submits with `C-m`; with tmux `extended-keys csi-u` Codex receives Ctrl+M = newline | `[tui.keymap.composer] submit = ["enter","ctrl-m"]`, newline on Shift/Alt+Enter, Ctrl+J |
| Restored Codex seats stuck `attention_required` | resume probe expects `gpt-…` footer / non-`sh` pane command | seat shim: slug display names, Codex made foreground process group |
| Codex activity `generation_mismatch` | shared Codex app-server daemon runs hooks with another seat's env (#69) | seat shim `--no-daemon` |
| Kernel Claude seats exited at launch | bypass-mode warning defaults to "No, exit" | `skipDangerousModePermissionPrompt: true` |
| Daemon crash on Node 24 (better-sqlite3 teardown) | native module ABI | OpenRig runs on Node 22 LTS |
| Seats lacked OpenRig's own skills (mission/slice procedure, handoffs) | the specs' `openrig-core` plugin is not loaded; seats start without `--plugin-dir` | install.sh symlinks OpenRig's 19 core skills into both harnesses |
| Project views missed most queue rows | rows lacked `project:<id>` and `worktree_path=` | the `rig` launcher sends seat `queue create/handoff` through `seat-tools/rig`, which adds both |
| Running seats kept old team rules; two seats lost their OpenRig instructions | managed blocks are written at launch; a git reset/merge of AGENTS.md wipes them | `agent-refresh-guidance <P> --apply` refreshes/restores them; a repo pre-commit hook stops them being committed |
| `rig spec audit`: no start-up context | team specs had no rig-level startup file | `rig/startup/context.md` (identity, environment, system check, skills) in every team spec |
| TUI: "no wave declared", readiness unknown/legacy, merged work shown unmerged | waves in queue rows (ignored when mission.yaml exists); YAML without official `metadata:`; no proof policy; stale local `main` | `agent-project-repair <P> --apply`; `agent-repos-sync.timer`; `agent-project-check` now asks the daemon what the TUI shows |

After an OpenRig upgrade run `openrig-upgrade <version>` and re-check these.

### Known limits (honest)

- CLIProxyAPI answers `400 unknown provider for model …` when **no** account of a family is eligible; `agent-recover`
  turns that into `POOL EXHAUSTED …` and escalates. Cooling (quota) accounts return 429 per the proxy's code (not exercised,
  to avoid burning subscriptions).
- An interrupted stream is **re-sent**, not continued: Codex retries the whole sampling request (observed: proxy restart
  mid-stream → retry 1/5 after 193 ms → success, no duplicate work). Claude Code likewise retries the request.
- Codex reasoning effort is global (`high`); OpenRig 0.5.x cannot set it per seat under YOLO (#75).
- Jev thresholds were tuned on the same 46 labelled cases they were measured on; add held-out cases before trusting
  fine distinctions. On error classification a keyword baseline matched Jev, so exact signatures are rules in code first.
- **Provider terms may prohibit pooling consumer subscriptions through a proxy.** Anthropic's Claude Code terms explicitly do. Read your providers' terms; if you pool anyway, that is your decision and your risk. `cliproxy-authwatch` alerts you when an account starts failing authentication, and `fallback-codex.yaml` keeps you working without Claude.

See `docs/ROLLBACK.md` and `docs/VALIDATION.md`.
