# agent-stack

A reproducible, local multi-agent software team for Linux. You write a plan; a team of AI coding agents turns it into
merged, user-tested features, and asks you for one approval plus genuine decisions.

- **OpenRig** runs the team: seats, roles, task queue, handoffs, watchdogs and a single merge owner.
- **Claude Code** is the harness for Anthropic models and Kimi K3; **Codex CLI** is the harness for OpenAI GPT-6 models.
- **CLIProxyAPI** pools your subscriptions (Claude, ChatGPT, Kimi) on `127.0.0.1:8317` with failover between accounts.
- **TypeSafe Jev** makes bounded, fast decisions (routing, triage, merge-gate veto); ordinary code owns anything exact.
- **Superpowers** gives each implementer a plan → test-first → verify discipline; **Playwright** gives agents a real browser.

The core rule: **a feature is done only when a person could use it.** Browser journeys are written before the feature
by a different model family, locked against the implementers by CI, and backed by a hands-on QA pass and a held-out suite.

| Concern | Owner |
|---|---|
| Account rotation, failover, cooldowns | CLIProxyAPI (`127.0.0.1:8317`) |
| Tasks, ownership, seats, sessions, messaging | OpenRig (`127.0.0.1:7433`) |
| Bounded semantic decisions (classify / select / score / yes-no) | Jev via `jev-decide`, MCP `jev_decide` |
| Capacity, dependencies, permissions, budgets, arithmetic | ordinary code (`orchestration/`, CI guards) |

## Install on a new machine

Needs Linux with a systemd user session, and subscriptions you are allowed to use this way (see Known limits).

```bash
git clone https://github.com/<you>/agent-stack ~/Projects/agent-stack
cd ~/Projects/agent-stack && ./install.sh          # safe to re-run; ./install.sh --check only reports
```

`install.sh` installs pinned versions from `config/versions.env` (OpenRig, CLIProxyAPI, Node), Claude Code and Codex via
mise, the helper scripts, shell environment, harness config, systemd services and timers, Superpowers, the Playwright MCP
browser, the TOON CLI and Jev. It never overwrites existing secrets, OAuth logins, the proxy config or a Codex config.
It finishes with the steps only you can do: `gh auth login`, one `agent-login <claude|codex|kimi> <label>` per
subscription, and your TypeSafe key.

## Staying current

- **OpenRig** follows upstream automatically: `openrig-update.timer` checks npm daily. It upgrades only when no project
  rig is running, re-applies this setup's adjustments (`bin/openrig-upgrade`), validates every team spec, rolls back on
  any failure, and on success bumps `config/versions.env` and commits it. Run `openrig-update --check` to see status.
- Everything that makes this setup yours (roles, specs, culture, starter kit, configs) lives in this repo, outside the
  OpenRig install, so upgrades cannot overwrite it.
- CLIProxyAPI: bump `CLIPROXY_VERSION` in `config/versions.env` and re-run `./install.sh` (sha256-verified download);
  rollback steps are in `docs/ROLLBACK.md`.

## Daily use

1. Make a repo from `starter-kit/` (locked acceptance journeys, CI guards, desktop+phone Playwright, PR template).
2. Copy `rig/template/build.yaml` (14 seats, models pinned per role) with `CULTURE.md` and the two watchdogs; `rig up`.
3. Write `docs/PLAN.md` and send the lead: `rig send coord-lead-claude@<rig> "Build docs/PLAN.md"`.
4. Approve the feature list when notified. You are notified again only for risky merges, blockers and the daily summary.

Full steps: `starter-kit/README.md` and `rig/template/README.md`. If the Claude accounts are unavailable, use
`rig/template/fallback-codex.yaml`.

```bash
rig ps --nodes --rig <rig>                # seat states
rig queue list -a -A                      # task ownership / handoffs
rig down <rig> --snapshot                 # stop (resume with: rig up <rig>)
agent-proxy-status [--recent 20]          # pool health / routing
jev-decide stats                          # Jev decisions
claude-pool                               # your own Claude Code session through the pool (Claude + Kimi models)
agent-login <claude|codex|kimi> <label>   # add or re-authenticate one account
```

The OpenRig service only starts the daemon and the kernel rig at boot; project rigs start when you run `rig up`.

## Models and routing

| Work | Model (harness) |
|---|---|
| Plan decomposition, acceptance criteria, architecture, UI, migrations, review of Codex PRs | Claude Opus 5.5 (Claude Code) |
| Volume implementation, unit tests, mechanical work, hands-on QA, review of Claude PRs | GPT-6 Sol (Codex) |
| Escalation after two red CI runs | GPT-6 Astra (Codex) |
| Long-context reading, third-family review of risky changes | Kimi K3, `kimi-k3[1m]` (Claude Code via the proxy) |
| Claude fallback when Opus is rate-limited | Claude Fable 5.1 |

Chosen from published benchmarks and checked with Jev; revise it from your own rig outcomes.

## Where things are

- Secrets (0600, never in git): `~/.config/agent-stack/secrets/{cliproxy.env,typesafe.env}`; OAuth tokens in `~/.cli-proxy-api/*.json`.
- Proxy config `~/.cli-proxy-api/config.yaml`; services `cliproxyapi`, `openrig` and timers `cliproxyapi-health`, `cliproxy-usage`, `openrig-health`, `cliproxy-authwatch` (alerts on repeated 401/403 for one account), `openrig-update` (user units, linger on).
- Pinned versions: `config/versions.env`.
- Jev decisions (single source of truth): `config/decisions.yaml`; evaluation: `eval/` (`node eval/run.js`); unit tests: `node --test 'test/*.test.js'`.
- Decision log: `~/.local/state/agent-stack/jev.sqlite` + `jev-decisions.jsonl` (state hash only, no raw payloads).
- Routing log: `~/.local/share/agent-stack/logs/proxy-usage.jsonl` (account, model, status, latency, quota; no content).
- Per-project team notes: `<repo>/.team/` (REQUIREMENTS, DECISIONS, plans, handoffs, incidents; git-excluded).
- Snapshot of non-secret system files: `system/` (secrets redacted).

## How seats get their configuration (launch and restart alike)

- **Claude seats:** OpenRig sets `OPENRIG_NODE_ID`; `~/.config/agent-stack/env.sh` (sourced by `~/.bashrc` before its
  interactive guard) then exports `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` for the pool, pins model aliases, and sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Your own `claude` keeps direct login and claude.ai connectors.
- **Codex seats:** global `~/.codex/config.toml` (pool provider, key via `auth.command`) plus the seat-only shim
  `~/.local/share/agent-stack/seat-bin/codex` (first on the OpenRig daemon's PATH): `--no-daemon`, slug display names,
  analytics/update checks off, and makes Codex the terminal foreground group.
- **YOLO:** `permission_policy: builtin:yolo` in each RigSpec you write and in all 13 built-in presets (re-applied by `openrig-upgrade`) (OpenRig ignores the
  ambient `OPENRIG_YOLO`). `skipDangerousModePermissionPrompt` in `~/.claude/settings.json` stops the bypass warning
  dialog from exiting seats.
- **Jev:** MCP server `jev` registered at user scope in both harnesses (runs outside the Codex sandbox); `TYPESAFE_API_KEY`
  exported in shells; skills `typesafe-ai` and `agent-stack` in both harnesses.

## Local fixes for OpenRig 0.5.17 + Codex 0.157 (no fork)

| Symptom | Cause | Fix |
|---|---|---|
| Messages to Codex seats never submitted | OpenRig submits with `C-m`; with tmux `extended-keys csi-u` Codex receives Ctrl+M = newline | `[tui.keymap.composer] submit = ["enter","ctrl-m"]`, newline on Shift/Alt+Enter, Ctrl+J |
| Restored Codex seats stuck `attention_required` | resume probe expects `gpt-…` footer / non-`sh` pane command | seat shim: slug display names, Codex made foreground process group |
| Codex activity `generation_mismatch` | shared Codex app-server daemon runs hooks with another seat's env (#69) | seat shim `--no-daemon` |
| Kernel Claude seats exited at launch | bypass-mode warning defaults to "No, exit" | `skipDangerousModePermissionPrompt: true` |
| Daemon crash on Node 24 (better-sqlite3 teardown) | native module ABI | OpenRig runs on Node 22 LTS |

After an OpenRig upgrade run `openrig-upgrade <version>` and re-check these.

## Known limits (honest)

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
