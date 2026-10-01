# agent-stack reference

The detail behind the [README](../README.md): the full team, what gets installed, the everyday commands, running
several projects, operating a fleet, upgrades, and how the pieces fit. Workflow skills and every other skill:
[SKILLS.md](SKILLS.md). Project environments: [PROJECT-ENV.md](PROJECT-ENV.md). Upgrades: [UPGRADE.md](UPGRADE.md).

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
   agree. Two failed attempts send the feature to a fresh seat on the same model (GPT-6.1 Sol); the operator may
   set GPT-6 Astra for it case by case.
8. **You get a daily summary**, and a final report when every feature is done.

## Who does what (the full-stack team, 27 seats)

Every seat is pinned to the model that published benchmarks and Jev picked for its job. Most of the work runs on
GPT-6.1 Sol; Claude Opus 5.5 orchestrates the team (its 1M-token context holds the whole backlog) and reviews Codex's
work, Claude Fable 5.1 plans and architects, and Claude Sonnet 5.5 builds user interfaces and big migrations and writes
locked tests.

Every slice, feature, fix and wave starts research -> plan -> implement: `## Research` and `## Plan` go in the slice's
PROGRESS.md before the first code commit (the rig CULTURE's "Research, plan, implement" section).

| Seat | How many | Model | What it does |
|---|---|---|---|
| Lead | 1 | Claude Opus 5.5 (1M context) | The orchestrator: keeps the whole backlog in mind, asks for your approval, hands out work, tracks progress, writes the daily summary |
| Deputy | 1 | GPT-6.1 Sol | Helps the lead dispatch, chase and keep notes |
| Architect | 1 | Claude Fable 5.1 | Turns your plan into features with acceptance criteria a person can check |
| Test authors | 3 | 2 × Sonnet 5.5, 1 × GPT-6.1 Sol | Write the locked browser tests before a feature is built (always the other family from its builder) |
| Builders | 8 | GPT-6.1 Sol | Build features, unit tests and routine changes |
| UI builders | 2 | Claude Sonnet 5.5 | Build screens and interfaces, and large database or code migrations |
| Escalation builder | 1 | GPT-6.1 Sol | A fresh seat for any feature that failed twice (the operator may set GPT-6 Astra case by case) |
| QA testers | 3 | GPT-6.1 Sol | Use each feature by hand like a real person and record screenshots |
| Reviewers | 4 | 2 × Opus 5.5, 2 × GPT-6.1 Sol | Opus reviews GPT's work and GPT reviews Claude's: different models catch different bugs |
| Third reviewer | 1 | Kimi K3 (1M context) | Extra review of risky changes; reads very large amounts of code at once |
| Merge owner | 1 | GPT-6.1 Sol | The only seat that merges; checks every gate first |
| Recovery | 1 | GPT-6.1 Sol | Unsticks stalled seats, broken builds and merge conflicts |

Claude Fable 5.1 stands in for Opus 5.5 when Opus is rate-limited. Smaller projects can use `build.yaml`
(14 seats), and `fallback-codex.yaml` keeps working with no Claude account at all.

## What gets installed

Everything is listed with versions in [`config/tools.md`](../config/tools.md). In short:

- **Programs:** OpenRig, CLIProxyAPI, Claude Code, Codex CLI, Node.js (via mise), ripgrep and fd for fast search,
  the TOON CLI for compact prompts, and Playwright with Chromium.
- **In every seat:** the **Superpowers** plugin (for Claude Code and for Codex) for disciplined plan → test → build →
  verify work; the **TypeSafe** skill; the **Neon** skills; this repo's **agent-stack** and **openrig-project-setup**
  skills; the six workflow skills (bug review board, verification guide, blast radius, review lenses, unslop,
  technical writing); OpenRig's own skills. Claude Code also gets the **Vercel** plugin. Every skill, its source and who gets it:
  [docs/SKILLS.md](SKILLS.md) (`agent-skills-check` shows what is missing).
- **Tools the agents can call:** **Jev** (fast typed decisions) and a **Playwright browser** (so QA can use the app
  like a person), both in Claude Code and Codex.
- **Background services:** the subscription pool, the OpenRig daemon, health checks, usage logging, a sign-in
  failure alert, a quota warning at 80%, and a weekly check for new OpenRig releases (upgrades are operator-run).

## What you need

- A Linux computer with systemd (built and tested on Arch/Omarchy; a 16-core, 64 GB machine runs several teams).
- Subscriptions, logged in through the proxy: at least one ChatGPT Pro (Codex) and one Claude Max plan; Kimi is
  optional. More accounts give more capacity and smoother failover.
- A GitHub account, and a [TypeSafe](https://typesafe.ai) key for Jev.

## Install

```bash
git clone https://github.com/korallis/agent-stack ~/Projects/agent-stack
cd ~/Projects/agent-stack && ./install.sh --apply   # --check only reports; --help; nothing else is accepted
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

It also sets OpenRig's queue pickup threshold (`queue.pickup_stall_threshold_minutes`) to 480 minutes. OpenRig's
default of 3 minutes paged "unclaimed" for rows that a busy seat picks up minutes later. An existing value is kept.

## Replicate on a new machine

Everything this setup needs is in this repo. On a fresh machine, from a normal login shell (not inside a seat: the
installer refuses a seat's `OPENRIG_HOME` when it isn't under the HOME it runs for):

1. `git clone https://github.com/korallis/agent-stack ~/Projects/agent-stack && cd ~/Projects/agent-stack`
2. `./install.sh --check`: reports what is missing and changes nothing: no file, directory, mode or backup under HOME,
   nothing in the repo, no unit started, no package fetched and no npm run (the Playwright browser check reads the npx
   cache and launches with a throwaway HOME). Claude Code and Codex are asked only once they have run in this HOME,
   because their first run writes their own state.
   Then `./install.sh --apply`.
3. Logins: `gh auth login`, then `agent-login claude|codex|kimi <label>` once per subscription.
4. Secrets, in `~/.config/agent-stack/secrets/` (0600, never in a repo):
   - `cliproxy.env`: local proxy keys, generated by the installer;
   - `typesafe.env`: paste your TypeSafe key (Jev), then `openrig-daemon-cycle`;
   - `playwright.env`: browser logins for the witness, one `NAME=value` per line, typed by name (see "Operating a
     running fleet").
5. `openrig-ensure --check`: OpenRig is at the pin in `config/versions.defaults.env` with every local patch applied.
6. `agent-project-new` for each project: a new repo (below), or an existing one (it adopts the repo's trunk and merge
   gate; see "An existing repo").
7. `agent-project-check <Project>`: nothing may say FAIL.
8. `./install.sh --check` again: nothing left to do.

The checklist was validated with `./install.sh --check` in a throwaway HOME (exit 0; no config, secrets or tools
written).

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

### An existing repo

Point `agent-project-new` at a repo that already has commits and an origin, and it adopts it as it is:
- it keeps the repo's trunk (e.g. `master`), and keeps a local `main` ref mirroring it for OpenRig;
- it keeps the repo's own GitHub rules (rulesets, a label that arms auto-merge);
- it puts the starter kit in `<Project>-work/starter-kit/`, for the lead to adopt in a PR, never in the repo.

Write the repo's specifics into `rig/CULTURE.md`: trunk, required checks, merge path, and whether merges deploy to
production (then every PR must be ship-safe, and the witness runs on the production URL). Keep the seats on
development data: [docs/PROJECT-ENV.md](PROJECT-ENV.md). The `openrig-project-setup` skill has the full example.

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

## Operating a running fleet

- **Watch the fleet: `rig-console`** (read-only, full screen; best at 176×50, works from 100×30).
  - `1` Mission Control: working / idle / stuck / blocked / owner decisions / gate-today (every rig's
    `review.merge_gate` decisions since 00:00 UTC, diagnosis calls excluded) tiles, one card per rig
    (seat dots per pod), work in flight by role, owner decisions, the account pool, system health, the event log and a
    live ticker.
  - `2` Seat Matrix: every seat of every rig, context use shaded (red at 80%+), activity glyphs, 24 h telemetry and the
    pool.
  - Keys: `←→` / `hjkl` move, `⏎` drills from a rig card into the matrix, `?` help, `q` quits.
  - It reads the daemon API and its event stream, the Jev decision log, `agent-proxy-status` and `agent-heavy status`
    through ONE cache. The cache refreshes every 5 s, never under 2 s, and backs off to 60 s when the daemon is slow.
    It never polls tmux and changes nothing.
  - Its 24 h history lives in `$AGENT_STACK_STATE/rig-console/history.json`.
  - `rig-console --once --fixture console/fixtures/demo.json` draws the neutral demo.
- **Relaunch a seat only when it is idle.** Codex: `C-u`, `/quit`, Enter. Claude: `/exit`. Then
  `rig launch <rigId> <pod.member>` (the rig ID, not its name). Check that it resumed its own conversation (Codex
  `resume <thread>`, Claude `--resume <session-id>` on its command line).
- **Retire a seat** with `rig seat stop`; restore it with `rig launch`.
- **Browser secrets:** the Playwright MCP reads `playwright.env` once, when it starts. Add everything a seat needs,
  then relaunch it once. Append; never rewrite the file. Prefix names with the project.
- **`rig ps` shows ATTN `user_prompt_submit`** while a seat works on a turn; that is not a stuck seat.
- **Never stop or restart `openrig.service`** while rigs run: restart the daemon with `openrig-daemon-cycle`.
- **Slack proof (screenshots, video, PDF to the owner):** an update row to the owner carries one file with
  `--evidence-ref <absolute path>` (.png/.jpg/.gif/.webp, .mp4/.webm/.mov, .pdf; at most 50 MiB), and the daemon
  uploads it into that message's Slack thread (OpenRig 0.6.3 + patch 141). Seats are taught when, how and what never
  to show (CULTURE "Visual proof for the owner"; the QA, lead and witness guidance).
  - The Slack app needs the bot scopes `files:write` (proof the seats send) and `files:read` (files the owner sends,
    e.g. a screenshot in a reply). `rig slack manifest` requests both; an app made before that adds them and is
    reinstalled.
  - `rig slack verify` checks only the configured required scopes, and the default list leaves both out, so it says
    READY on an app that can't send or read files. Add them once:
    `rig slack setup --required-scopes chat:write,channels:history,channels:read,files:read,files:write`.
  - `openrig-slack-upload-check` shows, sending nothing, whether patch 141 is in, the channel, and whether
    `SLACK_BOT_TOKEN` is present; `--live` uploads a generated 1x1 PNG (or `--file <abs path>`) to the channel
    through the installed client. It reads the token by name and never prints it; a failure prints only Slack's
    code, an HTTP status or a fixed category.
  - A row's text without its file: the daemon logged `ATTACHMENT … (text delivered; attachment missing)` with the
    reason (e.g. `missing_scope`, over the size cap, or the file was gone when it posted).

Details are in the `agent-stack` skill. What went wrong before: [docs/incidents/](incidents/).

## Staying up to date

- **OpenRig** never upgrades by itself: running seats would be interrupted. A weekly check (`openrig-update`) tells
  the upgrade owner when a newer release is out. The upgrade is an operator-run window
  ([docs/UPGRADE.md](UPGRADE.md)): `openrig-upgrade <version>` installs it and applies this setup's local patches
  (`patches/openrig/<version>/`); `openrig-update --validate` then checks the six team templates
  (`rig/template/` core, small, team, build, full-stack, fallback-codex) against it.
- **Versions:** the tracked pins are in `config/versions.defaults.env`; a machine can override them in
  `config/versions.env` (not tracked). The installer never downgrades OpenRig: if the installed version is newer than
  the pin, it keeps it ([docs/incidents/2026-09-30-openrig-downgrade.md](incidents/2026-09-30-openrig-downgrade.md)).
- Everything that makes this setup what it is lives in this repo, outside OpenRig's own files, so upgrades cannot
  overwrite it. CLIProxyAPI is updated by changing its version pin and re-running the installer.

## Technical reference

### Where things are

- Secrets (0600, never in git): `~/.config/agent-stack/secrets/{cliproxy.env,typesafe.env}`; OAuth tokens in `~/.cli-proxy-api/*.json`.
- **Transcript capture:** every 15 seconds, 400 lines (`transcripts.poll_interval_seconds`, `transcripts.lines`; set by
  `install.sh`). OpenRig's 2s/1000-line default across ~90 seats kept the daemon's event loop busy. `openrig-daemon-cycle`
  starts the daemon without the `OPENRIG_TRANSCRIPTS_*` overrides that seats inherit from tmux.
- **Daemon priority and health:** the daemon runs at `CPUWeight=1000` (10x a build or test) whether `openrig.service`
  or `openrig-daemon-cycle` started it. `openrig-health` probes `/healthz` 3 times (15s each, 10s apart). After a
  cycle it leaves a daemon that is merely slow alone for 10 minutes, alerting instead. A hung one (accept queue at 80%+
  of the backlog, or a main thread with no CPU progress) is cycled at once. It cycles at most 3 times in 30 minutes,
  then only alerts.
- **Heavy runs:** every seat runs tsc, eslint, tests, builds and Playwright through `agent-heavy build|browser -- <cmd>`
  (2 slots, capped CPU and RAM, max runtime 45min build / 30min browser; a stop at the cap is logged, `journalctl -t
  agent-heavy`). Memory (WO58): each run's scope has a ceiling and no swap (build 14G, browser 8G;
  `AGENT_HEAVY_<CLASS>_MEM`/`_SWAP`), and every scope sits in `agent-heavy.slice`, whose ceiling holds all heavy runs
  together to 24G (`AGENT_HEAVY_TOTAL_MEM`; set as a runtime property before each run). A run over either is OOM-killed
  inside its scope, exits 137 with a "killed: … memory ceiling" message saying how to rerun it focused, and is logged
  like a stop at the cap; the rest of the host keeps its memory. The job's env carries worker hints (4 unless set,
  `AGENT_HEAVY_WORKERS`): `PYTEST_XDIST_AUTO_NUM_WORKERS` (pytest `-n auto`), `VITEST_MAX_WORKERS` (Vitest 4+),
  `VITEST_MAX_THREADS`/`VITEST_MAX_FORKS` (Vitest 3). `node --test` and Jest read no such variable: pass
  `--test-concurrency=4` / `--maxWorkers=4`. Without a systemd user session it warns and runs the job unconfined, under
  `timeout` for the max runtime. Every scope is cleared afterwards (`reset-failed`), so failed ones don't pile up. It refuses long-lived servers (`npm start`,
  `start:*`, `dev`, `next start`, `vite`), which run outside it. `agent-heavy status` shows who holds each slot and who waits.
  Waiters queue first come, first served per class (a ticket each in the slot dir; only the first K live tickets, K =
  free slots, may try a slot, and a dead waiter's ticket is skipped). `--priority urgent|critical` (or
  `AGENT_HEAVY_PRIORITY`) sorts ahead of routine: for critical-path QA and merge-gate re-runs. It only orders the
  queue and never preempts a running job.
  A nested call of the same class (a script that wraps its own runs) runs inline in the parent's slot; a different
  class takes its own slot. The rig template's CULTURE.md makes it binding, and `agent-project-check` WARNs when a
  project's conventions lack it.
- **Playwright MCP:** a pinned `@playwright/mcp` release with Playwright's own Chrome for Testing (`--browser chromium`),
  not the system Chromium. The pin lives in `system/codex/config.toml`; `install.sh` registers Claude's MCP with it and
  `playwright-browsers` (daily timer) installs that release's own browser build. Bump the pin deliberately (0.0.80 =
  Chrome 153, 0.0.82 = Chrome 154), then run `playwright-browsers`. `@latest` can need a browser build that isn't
  installed yet.
- **Test credentials:** Playwright MCP runs with `--secrets ~/.config/agent-stack/secrets/playwright.env` (0600,
  `NAME=value`). An agent types a login BY NAME (`browser_type` text `"WITNESS_PASSWORD"`); the MCP types the value and
  shows `<secret>WITNESS_PASSWORD</secret>` in every snapshot and code line instead of it. The MCP also echoes tool
  input, so no env or credential value is ever inlined in `browser_run_code`/`browser_evaluate` either. Without it, a filled
  password shows in the snapshot. `install.sh` sets it up (`system/playwright-mcp-config`); seats get it when their MCP
  restarts.
- **Playwright MCP files, one dir per seat (WO83).** Both runtimes start the MCP through `agent-playwright-mcp`,
  which gives it `--output-dir ~/.local/state/agent-stack/playwright-mcp/<seat>/` (0700, with `net/` for network and
  console logs).
  - The seat is `OPENRIG_SESSION_NAME`, read from the nearest ancestor process when the runtime trims the MCP's
    environment (Codex does). Without one (the operator's shell, a human) it is `local`.
  - Page snapshots hold what the page showed, client data included. `agent-playwright-retention` (hourly timer)
    deletes them after `KEEP_HOURS` (48), and in a client-data rig's seat dirs after `CLIENT_DATA_HOURS` (6). Set
    `CLIENT_DATA_RIGS="rig1 rig2"` in `~/.config/agent-stack/playwright-retention.env`; `--dry-run` shows what would
    go.
  - Seats keep evidence by copying it into the slice's proof dir.
  - `install.sh --apply` moves (never deletes, never into a link) the shared dir's top-level files untouched for an
    hour into `unattributed-<date>/`.
  - Seats pick the new MCP command up when they relaunch (the normal idle-gated way; no mass relaunch). Until then
    their old MCP keeps working: the guard also allows its old network/console dir `playwright-mcp/net/<seat>/` (the
    denial names it), and that tree is not moved.
  - The hourly run ages the moved files, the old tree and any stray top-level file like the rest. A symlinked MCP dir
    or destination is refused.
- **Seats never depend on the daemon unit.** Every seat lives in the tmux server of `openrig-tmux.service`, not in
  `openrig.service`. tmux ties each pane to the unit its server runs in, which is how `systemctl stop openrig.service`
  once stopped every seat. Restart the daemon with `openrig-daemon-cycle` (the health check does too), never with
  systemctl. `openrig-tmux-adopt` moves an older server out of `openrig.service` without stopping seats.
- Proxy config `~/.cli-proxy-api/config.yaml`; services `cliproxyapi`, `openrig`, `openrig-tmux` and timers `cliproxyapi-health`, `cliproxy-usage`, `openrig-health`, `cliproxy-authwatch` (alerts on repeated 401/403 for one account), `cliproxy-quotawatch` (warns at 80% of any 5-hour or weekly allowance, critical when a whole provider is past it), `openrig-update` (weekly: raises an "upgrade window due" queue item for operator-agent@kernel; never upgrades by itself, see docs/UPGRADE.md) (user units, linger on).
- Pinned versions: `config/versions.defaults.env` (tracked) with an optional local override in `config/versions.env` (untracked; `openrig-upgrade` records the installed OpenRig there). OpenRig is never downgraded by a lower pin: `install.sh` (via `openrig-ensure`) keeps a newer install and moves the pin, and `openrig-upgrade` refuses an older version without `--allow-downgrade`.
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

### Local fixes for OpenRig + Codex (no fork)

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
| Slack proof screenshots never reached the thread ("ATTACHMENT upload-url FAILED … invalid_arguments; text delivered; attachment missing") | OpenRig 0.6.3 sends `files.getUploadURLExternal` as JSON, which Slack rejects; only images were attachable | patch 141: both upload calls form-encoded; video (.mp4/.webm/.mov) and PDF attachable up to 50 MiB; check with `openrig-slack-upload-check` |
| TUI: "no wave declared", readiness unknown/legacy, merged work shown unmerged | waves in queue rows (ignored when mission.yaml exists); YAML without official `metadata:`; no proof policy; stale local `main` | `agent-project-repair <P> --apply`; `agent-repos-sync.timer`; `agent-project-check` now asks the daemon what the TUI shows |

After an OpenRig upgrade run `openrig-upgrade <version>` and re-check these.

### Credential read guard

Seats never stop for permission, so instructions alone don't stop a seat printing a credential file into its
transcript (two leaks on 2026-09-30, both `cat` of a runtime-url file). `system/credguard-read-hook` is a PreToolUse
hook that refuses the tool call instead. `install.sh` places it at `~/.local/share/agent-stack/bin/agent-credguard-read-hook`
and `system/credguard-read-install` merges it idempotently, keeping every other hook and backing up a changed file:
- **Claude Code:** `~/.claude/settings.json` `hooks.PreToolUse`, matcher `Bash|Read|Grep`, plus a second entry for the
  Playwright network/console tools (below). It answers with a JSON
  `permissionDecision: "deny"`, which blocks even under `bypassPermissions` (per the hooks guide). Running sessions
  pick up settings-file hook changes through Claude Code's file watcher, so seats need no relaunch.
- **Codex:** a managed block in `~/.codex/config.toml`: `[[hooks.PreToolUse]]`, matcher `Bash`, and a second group for
  the Playwright network/console tools (Codex runs PreToolUse hooks for MCP tools too, named `mcp__<server>__<tool>`,
  with the tool's arguments as `tool_input`), each with its own trusted hash. That is the name
  Codex gives its `exec_command` shell tool in hooks, and Codex reads files only through that shell. The block also
  holds the hook's `[hooks.state."<config>:pre_tool_use:<n>:0"] trusted_hash`: Codex runs a config hook only when
  that hash matches, and it is Codex's own (sha256 of the canonical JSON of the hook's identity; checked against a
  hash Codex wrote itself). The installer finds the group's position by parsing the TOML (Python's `tomllib`), then
  parses the result again to prove the guard sits there with its trust recorded; a file it can't parse, or can't
  extend safely, is left unchanged and reported. Codex's own `hooks/list` (app-server) reports the installed guard as
  `trusted` and `enabled` (a test runs it where `codex` is installed). A deny is exit 2 with the reason on stderr. Codex reads its config at start, so Codex
  seats get the guard at their next launch. `[features] hooks = true` must be set (OpenRig sets it).

What is refused: a read or print verb (`cat`, `head`, `tail`, `less`, `bat`, `jq`, `grep`, `rg`, `awk`, `sed`
without `-i`, `xxd`, `od`, `strings`, `base64`, `cut`, `diff`, …) with a protected file as an operand or `<` input;
`$(< file)`; `cp`/`mv`/`dd` to the terminal; `git show|diff|log|blame` of one; `bash -c`/`sh -c`/`eval` of any of
these, in any spelling (`bash --norc -lc`, `env -u X`, `env -S`, a `( … )` subshell or `{ …; }` group, `if`/`while`
bodies, `timeout`, `sudo`); command substitutions inside an unquoted heredoc (`<<EOF` runs them; `<<'EOF'` doesn't);
and `source`/`.` of one followed by `env`, `printenv`, bare `export`/`set`/`declare`, `export -p` or `echo`/`printf`
of a variable. Options are read as each tool reads them: `--` ends them, value-taking options take their value, and
a pattern operand is a pattern (`grep -- -l .env` prints; `grep -- .env README.md` names no protected file). The Read tool on one, and a Grep content search of one, are refused too. What is allowed:
- using it without printing: `set -a; . .env; set +a; <cmd>`, `--env-file`, `docker run --env-file`;
- `grep -q`/`-c`/`-l` on it (also as `grep -q X < .env`), `wc`, `sha256sum`, `test -f`, `stat`, `ls`, and
  `agent-credguard-read-hook --keys <file>`, which prints only the key names (nothing for a key file). `cut -d= -f1`
  is refused: it prints every line without a `=` whole;
- `set -e` and other shell options after loading (bare `set` dumps variables and is refused);
- `cp` to another file, `sed -i`, and writing to it;
- a grep/rg/awk/sed pattern that merely looks like a file name (`grep -rn runtime-url docs/`);
- heredoc bodies, which are data, not commands.

Protected paths: `**/.env`, `**/.env.*` (not `.env.example`, `.sample` or `.template`), `**/*runtime-url*`,
`**/*.pem`, `~/.config/agent-stack/secrets/**` and `**/prod.env`. Add machine- or project-specific globs, one per
line, in `~/.config/agent-stack/credguard-read-paths`. That file is local and never committed: put paths that name a
project there.

The deny message says how to use the values by name. `agent-never-prompt-check` (and so `agent-project-check`)
FAILs when the guard is missing from either runtime, or when Codex would skip it: `[features] hooks = true` unset, or
no `trusted_hash` equal to the hash of the guard as written (it recomputes it, the way Codex does).

Paths are resolved the way the shell will run the command:
- A glob is expanded against the real directory when it can be read, with bash's rule: a name starting with `.` is
  matched only by a pattern starting with `.`, or with `shopt -s dotglob` / `bash -O dotglob`. So `grep x bin/*`
  passes, while `cat app/.*` and `shopt -s dotglob; cat app/*` are refused. `**`, a glob in a directory part, or an
  unreadable directory are judged against sample names, dotfiles included.
- Bracket classes (`.[e]nv`, `[!x]`, `[[:alpha:]]`) match the way bash matches them.
- Every directory the command may be in counts: each `cd`/`pushd`/`env -C` target is added and none is dropped, so a
  subshell's `cd`, `popd` or `cd -` can't hide one. The cost: `cd` into a secrets directory and back out, then a read
  of an ordinary file by the same bare name, is refused too; run it as its own command.
- An existing symlink is followed to what it names.
- A name the command gave a protected file (`cp`, `ln`, `mv`, `dd of=`, `tee < file`, `cp -t DIR`, a copied
  directory and everything under it) is protected for the rest of the command, globs over it included.
- `$'…'` escapes (`\x`, `\u`, `\U`, octal), simple `{a,b}` braces, and variables the command sets are expanded:
  `F=…`, a prefix `F=… cmd` or `env F=… cmd`, `export`, `declare`, `local`, `readonly`, `read … <<< …` (escapes
  decoded first unless `-r`, then `-d`/`-n`/`-N`, then split into fields by `IFS`; `-a` too) and `for f in …`; `${F}` and `${F[i]}` too (any element of an
  array counts as any index), while other `${F…}` forms count as unresolved. An assignment that may not reach the shell (in a `( … )` subshell, a pipeline, `&`, an
  `if`/loop body, or after `&&`/`||`, a `{ … }` group there included) only adds a value. A prefix `F=… cmd` (or `env F=…
  cmd`) holds for that command's environment only: its own words and redirections use the old value, a shell it starts
  (`bash -c`, `env -S`, `eval`) the new one (in `bash -c "…"` the parent first expands its unquoted and
  double-quoted `$F` with the old value), and its redirections, `cd`, copies and `shopt` still count. `shopt -u dotglob` counts
  only where it surely applies.
- Backstop: if the command names a protected path anywhere, a print whose operand still holds a value the guard can't
  resolve (a variable it didn't see set, a substitution) is refused.

**Vercel protection bypass (WO62).** A project's protection-bypass secrets are the KEYS of its `protectionBypass`
object. The read guard refuses any Bash command or content Grep that names `protectionBypass`/`protection_bypass` (any
case), and `~/.local/state/agent-stack/vercel/**` (where the seat guard lets `vercel api …/projects…` write) is a
protected path. Inline interpreter code (`node -e`, `python -c`, `ruby -e`, `perl -e`, `bun`, `deno eval`, `php -r`)
is read too: a string literal or path-like word in it that names a protected file refuses the command, as `cat` would.
`agent-vercel-protection-status <project>` gives the yes/no answer. Code fed to an interpreter on stdin (a heredoc, a
script file) is still not parsed.

**Playwright network and console listings (WO57).** `browser_network_requests`, `browser_network_request` and
`browser_console_messages` (Playwright MCP 0.0.80) return request URLs, headers or console text, where tokens minted at
runtime appear (session JWTs, `?token=`, signed URLs, dev-browser tokens); `--secrets` only masks the values listed in
its file. The same hook, registered for `^mcp__.+__browser_(network_requests|network_request|console_messages)$` in
both runtimes, allows them only with the tool's own `filename` set to an absolute path in the seat's scratch dir,
`~/.local/state/agent-stack/playwright-mcp/<OPENRIG_SESSION_NAME>/net/` (made 0700; no symlink on the way), named by
what the call writes: `requests-…` (the list), `request-…` (one request's details), `part-…` (one `part`: a raw
header block or body, written as is) or `console-…`. With
`filename` the MCP writes the file and returns only a link to it. That dir is in the default protected patterns, so
`cat`, Read, content Grep and copies of it are refused like any credential file, a glob into it included.
`agent-net-summary <file>` takes the file's kind from that name, never from its content (a raw body can look like
anything), and reads only that kind's own record lines; a `part-…` file or any other name prints only a line count. It
prints one line per request, `<n>. <METHOD> <host><path> => <status>`: query strings,
fragments, `user:password@` and `;params` are dropped, token-like path segments (long hex, JWTs, long mixed runs) show
as `<masked>`, and headers, bodies and console messages are only counted. The MCP runs with
`--output-dir ~/.local/state/agent-stack/playwright-mcp/<seat>/` (agent-playwright-mcp, both runtimes), because it writes
only inside its output dir or the workspace; until a seat's MCP has that flag, the call fails with the MCP's "File access denied",
which leaks nothing. Seats pick up the new MCP args at their next launch; the hook entries load as above.

Limits (honest): it stops accidental printing by a seat, not a determined one. A script that reads and prints a
file itself (`node -e`, `python -c`, a project script) isn't parsed. A path held by a variable from outside the
command, or built by a substitution in a command that names no protected path, isn't known either. A broken hook allows the call rather than stopping every seat. `export $(grep -v '^#' .env | xargs)` is refused
(conservatively); use `set -a; . .env; set +a` instead.

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

## Models and decisions

### Who runs what

Every team template (`rig/template/*.yaml`) and every onboarding uses these defaults. Jev decided them per role on
2026-10-01 with `intake.specialist` (caller `operator:model-routing-2026-10-01`, every role in the act band), in two
runs: the first named the roles below; the second covered the Codex test author (0.69), Codex architect incl.
`arch.astra` (0.64) and the Codex lead of `fallback-codex.yaml` (0.60). The 2026-09-30 comparisons (request ids)
are kept where a role didn't change.

| Seats | Model | Why |
|---|---|---|
| Lead | `claude-opus-5-5` (`[1m]` in full-stack) | unchanged (2026-10-01) |
| Architect | `claude-fable-5-1` | Jev 0.62 against Opus 0.33 for planning and architecture (request `ba1a44dc`). Fable bills to the account's usage credits, outside the subscription pool. |
| Every Codex seat (implementers incl. the escalation seat, reviewers, QA, merge owner, recovery, deputies, test authors, architects, the fallback lead) | `gpt-6.1-sol` | 2026-10-01 (both runs); before: `gpt-6-astra` / `gpt-6-sol`. The operator may set `gpt-6-astra` for an escalation case by case |
| Claude UI implementers and test authors | `claude-sonnet-5-5` | 2026-10-01; before: `claude-opus-5-5` |
| Claude reviewers | `claude-opus-5-5` | unchanged (2026-10-01) |
| Kimi reviewers / test author | `kimi-k3[1m]`, `kimi-k3-256k` | unchanged (2026-10-01) |
| Claude's default Sonnet (`ANTHROPIC_DEFAULT_SONNET_MODEL`, proxy settings and env.sh) | `claude-sonnet-5-5` | follows the routing |

**Fable's one-time consent.** An account may need a one-time consent before Fable can bill usage credits. The seat
start-up context tells a Fable seat to stop and tell the lead instead of carrying on silently, and
`agent-project-check <Project>` WARNs when a Fable seat's screen asks for the consent or says the model is
unavailable. The fix: run `/model fable` once in that seat, accept, then relaunch the seat at idle.

### Jev as the decision layer

Code gathers the evidence and owns the thresholds; Jev makes the judgment; anything short of the act band goes to
the lead or a person. Send Jev evidence, not conclusions.

- **Merge gate:** `agent-merge-evidence <pr> --mission M --slice S --deploy "..." --decide` builds the
  `review.merge_gate` input from exact-head facts:
  - full head and base shas, and every required check by name. When the base branch has no required checks at all
    (no ruleset or protection, e.g. an integration branch), it reports what ran on the exact head instead:
    `base <branch> has no required checks; observed on exact head <sha>: <name>=<result>, …`. That is each check
    run's latest result and each status's latest state, kept apart when they share a name (`verify (status)`), and
    without the review and gate, whether posted as statuses or as check runs. A failing or unfinished one is named as
    NOT passing and holds the gate. Any protection keeps MISSING: a required check not yet reported, and also rules
    with no status checks (signatures, reviews). So does unreadable or incomplete check-run data. Only push-side
    rules (deletion, non-fast-forward, creation) count as unprotected;
  - the `independent-review` status and the review report its `target_url` links to (what the reviewer verified). A
    link to a GitHub review on this PR (`…/pull/<n>#pullrequestreview-<id>`) is read from the API, together with the
    commit it was submitted on ("submitted on this head" or "on commit <sha>, not this head").
    Reviewers set that link to their review comment. Without a link the report is MISSING; the latest comment naming
    the head is passed on only as UNVERIFIED, never as the review;
  - QA's `proof/brb-<head>.md`, and the blast radius with its link and whether it names the head. A blast radius is a
    "Blast radius" section at any heading level, a bold lead-in or a plain "Blast radius: …" paragraph, in a note's own
    lines. The selected review's own section is preferred, then the newest note naming this head, then the newest
    note, labelled "does NOT name this head". Its excerpt has its own 900-character budget, redacted before it's cut. If
    no proof file exists for this head, which happens after a branch refresh leaves `brb-<old head>.md`, a QA seat's
    PR comment can carry the verdict. Its first line names a `qa-` seat, and it declares `Head: <this head>` and
    `Verdict: SHIP|PASS`. It is shown as a self-declared seat, with any proof file on record for another head. A QA
    comment for another head never carries;
  - `change`: `--change "<1–3 lines>"`, else the PR title plus the body's first section (up to its first heading, at
    most 600 characters);
  - the target branch, the deploy effect, and the rollback (a rollback nobody stated is labelled as a proposed
    default).

  A missing check, status, review, proof, blast radius or deploy effect says MISSING, unless verified facts show it
  doesn't apply, and then it says `N/A: <reason>` with those facts:
  - the bug-review-board proof: the PR was created before the rig's cutoff (`AGENT_BRB_REQUIRED_SINCE`, else the rig
    CULTURE's "Transition (…): PRs opened before HH:MMZ" bullet), or every changed path is docs (`docs/**`, `*.md`),
    or CI configuration (`.github/workflows/**`, `.github/actions/**`, `.gitlab-ci.yml`, `.circleci/**`,
    `.buildkite/**`, `azure-pipelines.yml`, `Jenkinsfile`), or a mix of the two. These have no user-facing behaviour.
    A CI change still needs its blast radius, since it can break builds, and the risky tier's owner glance is
    unchanged;
  - the blast radius: every changed path is under `tests/acceptance/`, docs, or a `features.json` change that only
    flips `"key": true|false` values (read from the diff hunks, never the PR title).

  A mixed change (one docs file and one source file) still needs both.

  GitHub reports a PR as BLOCKED while any merge requirement is unmet, including `jev-merge`, the status this gate
  posts. The helper reads every requirement on the base branch (rulesets and classic protection). It says nothing
  about the merge state (the limits line reads just `mergeable: MERGEABLE; draft: false`) only when all of these
  hold. Any wording about the gate's own status, "pending this gate" included, read to the gate as a missing gate
  and made it hold on every project rig (WO50):
  - `jev-merge`, the gate's own status, is the only thing unmet, whatever it says;
  - every other required context passes. Every same-name result counts: a failing check is not hidden by a successful
    status of the same name. A context bound to an app (a ruleset's `integration_id`, protection's `app_id`) is met
    only by that app's latest check run;
  - nothing else applies that the helper can't verify: required deployments, signed commits, a merge queue, linear
    history, resolved conversations, a locked branch, merge restrictions, or a required review GitHub gave no
    decision on;
  - there is no review requirement outstanding, and no conflict.

  Otherwise the merge state stays BLOCKED and lists each reason ("not verified by this helper: ..." for the kinds
  above). Unreadable requirements or check runs keep BLOCKED. GitHub's UNSTABLE (mergeable, but some check or status
  isn't passing) is explained the same way:
  - `UNSTABLE (only non-required checks not passing: lint (failure); every required check passes)`;
  - `UNSTABLE (required check(s) not passing: verify (failure); …)`;
  - unreadable data says so.

  The gate's own context is never among them. The gate's own `jev-merge` is never evidence against
  itself, and never mentioned. An earlier run's result on the same head is not a merge-state reason. It is dropped
  from the required checks in `ci` and from the gate's problems, so a re-gate after its own HOLD (or MERGE) reads like
  a first run. Otherwise every hold would re-hold itself. Those
  earlier runs on this head (statuses, or gate comments declaring the head) are listed in a separate `history` field
  of the command's output, for people. It is never sent to Jev, and an older head's runs never appear. The command
  prints `{"input": {…}, "history": […]}` (with `--decide`, plus `"decision"`): `input` is exactly what Jev decides
  on. Never build a Jev input by hand from the printout, and never copy `history` into one. To add evidence the helper
  doesn't collect, write it to a file and pass `--extra-evidence <file>`. It goes into `input.review` as "additional
  evidence supplied by the caller (<file>; not verified by this helper)", whitespace-collapsed, at most 1500
  characters, and redacted like other free text. An empty or missing file stops the command (exit 2). The gate's own
  reports are kept out of every other collector too: the review fallback, the blast radius, and the review and QA
  comment sources. A gate report is a comment a gate status links to, one under the configured gate heading, one
  headed `## jev-merge`, or one reporting a gate result: its first line mentions Jev or the merge gate
  ("integ-codex: live Jev merge gate HOLD"), or it holds the helper's own "merge gate: HOLD (…)" line. One signed by a
  review or QA seat stays evidence. Free text is
  redacted before it
  goes to Jev. The helper refuses if the PR's head or base moves while it collects. A live, not stubbed, Jev `merge`
  in the act band merges on its own (exit 0). A live `merge` below the act bar (review or uncertain band) is NEEDS
  CONFIRM (exit 3) when every gate the helper checks is green: required checks pass, the review verdict is success,
  QA's proof is a `qa` PASS for this head, the PR is not a draft, GitHub says mergeable, and the branch is neither
  behind nor conflicted. The integrator then checks the repository's own gates (starter-kit journeys, risk tier,
  owner OK), asks the other-family independent reviewer for a one-line exact-head `confirm <sha>`, and merges.
  Anything else holds (exit 1), naming what isn't green. Before this, the gate was asked with hand-written summaries: of 288 calls (2026-09-28 to 2026-09-30),
  79 were act (27%), 62 review (22%) and 147 uncertain (51%). Measure the change with
  `jev-decide stats --since <date the helper went live>` (row `review.merge_gate`).
- **Where the evidence lives:** by default the independent review and the gate are commit statuses
  (`independent-review`, `jev-merge`) and QA's verdict is the proof file. Some repositories record them as PR
  comments instead. Configure that per repository in `$OPENRIG_WORK_ROOT/.agent-stack/merge-evidence.json`, or point
  `AGENT_MERGE_EVIDENCE_CONFIG` or `--config` at a file:

  ```json
  {
    "repos": {
      "acme/shop": {
        "review": { "source": "comments", "heading": "^## review-(claude|codex|kimi)" },
        "qa":     { "source": "comments", "heading": "^## qa-" },
        "gate":   { "source": "comments", "heading": "^## jev-merge" },
        "authorFamily": "codex"
      }
    }
  }
  ```

  Top-level `review` / `qa` / `gate` / `authorFamily` keys set defaults for every repository; `repos` overrides them.
  Sources: `review` is `status` (default; `context` names it) or `comments`; `qa` is `proof` (default) or `comments`;
  `gate` is `status` (default; `context`) or `comments`. A PR comment or review is a record for the head only when:
  - its first line matches the heading regex. The seat is the first word of that line (`## review-claude-2 ...`);
  - it declares exactly one candidate, and that candidate is the full 40-character head sha. The declaration is a
    line of its own: `head: <sha>`, `candidate_sha: <sha>`, `reviewed head <sha>` or `confirm <sha>`. A sha
    mentioned inside a sentence ("next head <sha> has not been reviewed") is not a declaration. A short sha, another
    sha, or two different shas never count.

  Fenced code blocks and quoted (`>`) lines are examples or citations, so they are never read as declarations. The
  verdict comes only from explicit declarations:
  - a `confirm <sha>` line;
  - each `Verdict:` line: PASS, APPROVE, YES or MERGE for success; FAIL, BLOCK, NO, HOLD or CHANGES_REQUESTED /
    CHANGES REQUESTED for failure;
  - a GitHub review's own state (APPROVED or CHANGES_REQUESTED).

  The heading only identifies the seat. Words in it ("evidence remedy for HOLD 7db8271e"), request ids, and `Ship:`
  or `Result:` lines are never a verdict. A record with no `Verdict:` line has no verdict, so the review is NONE
  VERIFIABLE ("no verdict stated"), never an inferred failure.

  It is success only when every declaration says success. Any failure, and so any conflict, makes it failure. An
  unreadable value is "unclear", and a record with no verdict counts as no verdict; neither is success. Nothing is
  inferred from other free text. The latest record decides, so a newer rejection supersedes an older PASS.

  The review is the latest record by a seat of another model family than the PR author's. The author's family comes
  from `--author-family`, else `authorFamily`, else an `agent/<seat>` head branch. If the family is unknown, no comment
  review counts and the review is MISSING, saying why. The selected review's body goes into the evidence, with its
  link, time and seat, and redacted like every other free text. Limits it states (`LIMIT:`, `Caveat:`,
  `Not verified:`, `Untested:`) are repeated in the limits field. QA's latest record stands in for the proof file
  (PASS, BLOCKING or UNCLEAR), and the gate's own comments on the head go into `history` (never into Jev's input). Commit statuses are
  read across all pages. A bad config (unknown source, missing or invalid heading) stops the helper with exit 2.
- **The review verdict:** the first line of the review evidence is always
  `review verdict: <success|failure>, from <source>; bound to head <sha>`. The verdict reaches Jev even when the
  report the status links to can't be read (a link outside the PR). It comes from verified sources only. The
  configured source goes first, then the others, in this order:
  1. the `independent-review` status on the exact head: its own state and description. With `identityHeadings`,
     the description's signer, its FIRST word (`review-codex-1: PASS`, `Kimi: PASS`), is tested with each pattern
     exactly as written, both as a plain first line (`Kimi`, for `^Kimi$`) and as the heading it would sign
     (`## review-codex-1`). That gives the status's family. A status
     signed by the author's own family is not an independent review. Neither is one whose signer matches patterns
     of two families. Mentions elsewhere in the text are not identities. A signer matching no pattern is taken as
     before;
  2. GitHub PR reviews submitted on the exact head. The review's commit must equal the head, so a review of an older
     commit never counts as current; such reviews are counted as ignored. APPROVED and CHANGES_REQUESTED are verdicts,
     combined with any the body declares. A COMMENTED review counts only if its body declares one. Dismissed reviews
     never count. The reviewer must be a login mapped to another family than the author's, in `identities`
     (`{ "identities": { "<github login>": "claude" } }`, top level or per repository). Where every seat posts as
     ONE shared login, map it to `"shared"` and add `identityHeadings`: a regex on the review body's first line
     mapped to a family (`{ "^## review-codex": "codex", "^## review-claude": "claude", "^## review-kimi": "kimi" }`).
     A review whose login is unmapped or shared takes its family from a matching heading; a login mapped to a family
     always wins. The review's commit must still be the exact head. **Trust limit:** with a shared login the heading
     is self-declared, so it is only as trustworthy as the seats. Nothing on GitHub proves which seat wrote it;
  3. review comments declaring the head (above). A review `heading` with source `status` makes them the last
     fallback. Comment sources (review, QA, gate) read PR comments only. A GitHub review is always its own source,
     under the rules in 2, so a stale, dismissed, pending, unmapped or same-family review never counts as a
     comment.

  When the verdict comes from a fallback source, that source's report (link, time, author) and its stated limits go
  into the evidence with it.

  If a verifiable source disagrees with the first one, the verdict is CONFLICT and lists both. If none is
  verifiable, it is `NONE VERIFIABLE`, with what each source lacked. For the gate, the review must be `success`.
- **Dispatch:** `agent-dispatch pick-seat --rig R --role implementer --task "..."` (the role, or its pod's short name:
  `impl`, `review`, `qa`, `arch`, `integ`, `tests`, `ops`; an unknown role is an error naming the valid ones) lists the running seats of the role
  that are idle with no open work, with their load notes (code), and Jev's `intake.seat` picks one. On review or uncertain the lead picks
  and records why in the row.
- **Stuck seats:** `agent-stuck-check` runs every 10 minutes. For a seat holding work whose screen stopped changing,
  cycles, or repeats a line, it asks Jev's `seat.stuck` (progressing, looping, rate-limited, stalled or unclear) and
  warns the rig's lead, at most once an hour per seat and verdict. It never acts. At most 10 Jev calls a run, the
  seats asked longest ago first; a warning counts as sent only when `rig send` succeeded; the evidence is redacted. Checked against live Jev before
  shipping, all act band: a real rate-limit stall (a 429 with credentials cooling down) came back `rate_limited`
  (0.93, request `a1a04515`), a test run `progressing` (`fd6306b0`), a repeated failing build `looping`
  (`1190d376`), and a seat idle at its prompt holding work `stalled` (0.96, `0091b260`).

### No advisor, for now

Claude Code's advisor ([docs](https://code.claude.com/docs/en/advisor)) is off for the fleet; Jev advised against it
(request `58478277`). Our seats set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which also turns off the advisor's
feature flags, and each advisor call re-reads the conversation without the prompt cache, a cost every seat would pay
on every turn. Revisit after the Fable architects have run for a while.
