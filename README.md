# agent-stack

Local multi-agent setup on **Beast** (Omarchy 4.0.4, Ryzen 9 9950X3D2 16C/32T, 59 GiB RAM):
a balanced **12 Claude Code + 12 Codex** team coordinated by **OpenRig**, running on **4 ChatGPT Pro + 2 Claude**
subscriptions pooled by **CLIProxyAPI**, with **TypeSafe Jev** for bounded semantic decisions.

| Concern | Owner |
|---|---|
| Account rotation, failover, cooldowns | CLIProxyAPI (`127.0.0.1:8317`) |
| Tasks, ownership, seats, sessions, messaging | OpenRig (`127.0.0.1:7433`) |
| Bounded semantic decisions (classify / select / score / yes-no) | Jev via `jev-decide`, MCP `jev_decide` |
| Capacity, dependencies, permissions, budgets, arithmetic | ordinary code (`orchestration/`) |

## Versions (installed 2026-09-27)

| Component | Version | Location |
|---|---|---|
| CLIProxyAPI | 8.0.2 (sha256-verified release) | `~/.local/share/agent-stack/cliproxyapi/releases/8.0.2`, `current` symlink |
| OpenRig | 0.5.17 on Node 22.23.3 | `~/.local/share/agent-stack/openrig`, wrapper `~/.local/bin/rig` |
| Claude Code | 2.1.283 (mise) | proxy via `claude-pool` and OpenRig seats |
| Codex CLI | 0.157.1 (mise) | proxy is the default provider |
| TypeSafe skill | plugin `typesafe@typesafe-ai` 0.5.7 (Claude), `~/.agents/skills/typesafe-ai` (Codex) | |
| TypeSafe JS SDK | `@typesafe-ai/sdk` 0.6.0, model pinned `jev-1.13.0` | `jev/` (Node 24.21.0) |
| tmux | 3.7c (Omarchy config unchanged) | |

## Daily use

```bash
agent-team up ~/Projects/<repo>          # worktrees + rendered RigSpec + validate + rig up (24 seats)
agent-team up ~/Projects/<repo> --pilot  # 1 Claude lead + 1 Codex implementer
agent-team grow|shrink <repo> <seat…>    # resize (see `agent-team roster`)
rig send coord-lead-claude@team-<repo> "…your request…"
rig ps --nodes --rig team-<repo>         # seat states;  rig down team-<repo> --snapshot / rig up team-<repo>
agent-proxy-status [--recent 20]         # pool health, per-account quota, routing log
jev-decide stats                         # who decided: jev | cache | fallback_model | code
claude-pool                              # your own Claude Code session through the pool
agent-login <claude|codex> <label>       # (re)authenticate one account
```

## Where things are

- Secrets (0600, never in git): `~/.config/agent-stack/secrets/{cliproxy.env,typesafe.env}`; OAuth tokens in `~/.cli-proxy-api/*.json`.
- Proxy config `~/.cli-proxy-api/config.yaml`; services `cliproxyapi`, `cliproxyapi-health.timer`, `cliproxy-usage.timer`, `openrig`, `openrig-health.timer` (user units, linger on).
- Jev decisions (single source of truth): `config/decisions.yaml`; evaluation: `eval/` (`node eval/run.js`); unit tests: `node --test 'test/*.test.js'`.
- Decision log: `~/.local/state/agent-stack/jev.sqlite` + `jev-decisions.jsonl` (state hash only, no raw payloads).
- Routing log: `~/.local/share/agent-stack/logs/proxy-usage.jsonl` (account, model, status, latency, quota; no content).
- Per-project team state: `<repo>/.agent-team/` (REQUIREMENTS, DECISIONS, plans, handoffs, incidents; git-excluded).
- Snapshot of non-secret system files: `system/` (secrets redacted).

## How seats get their configuration (launch and restart alike)

- **Claude seats:** OpenRig sets `OPENRIG_NODE_ID`; `~/.config/agent-stack/env.sh` (sourced by `~/.bashrc` before its
  interactive guard) then exports `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` for the pool, pins model aliases, and sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Your own `claude` keeps direct login and claude.ai connectors.
- **Codex seats:** global `~/.codex/config.toml` (pool provider, key via `auth.command`) plus the seat-only shim
  `~/.local/share/agent-stack/seat-bin/codex` (first on the OpenRig daemon's PATH): `--no-daemon`, slug display names,
  analytics/update checks off, and makes Codex the terminal foreground group.
- **YOLO:** `permission_policy: builtin:yolo` in every generated RigSpec and in the kernel specs (OpenRig ignores the
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
- Provider terms may restrict pooling subscriptions through a proxy (risk accepted by the owner).

See `docs/ROLLBACK.md` and `docs/VALIDATION.md`.
