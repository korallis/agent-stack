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
| CLIProxyAPI | 8.0.3 (sha256-verified release, upgraded 2026-09-28) | `~/.local/share/agent-stack/cliproxyapi/releases/8.0.3`, `current` symlink |
| OpenRig | 0.5.17 on Node 22.23.3 | `~/.local/share/agent-stack/openrig`, wrapper `~/.local/bin/rig` |
| Claude Code | 2.1.283 (mise) | proxy via `claude-pool` and OpenRig seats |
| Codex CLI | 0.157.1 (mise) | proxy is the default provider |
| TypeSafe skill | plugin `typesafe@typesafe-ai` 0.5.7 (Claude), `~/.agents/skills/typesafe-ai` (Codex) | |
| TypeSafe JS SDK | `@typesafe-ai/sdk` 0.6.0, model pinned `jev-1.13.0` | `jev/` (Node 24.21.0) |
| tmux | 3.7c (Omarchy config unchanged) | |

## Daily use (plain OpenRig)

Every repo's rig uses the shared roles in `rig/template/` (lead, deputy, architect, implementer, reviewer, merge owner,
recovery). Per repo you copy `core.yaml` (4 seats) or `team.yaml` (24), `CULTURE.md` and the merge-sweep watchdog into
`<workspace>/rig/` — see `rig/template/README.md`. The merge owner merges each PR once CI, an independent review and
live Jev agree (shared `review.merge_gate` decision unless the repo has its own procedure). Example: `~/Projects/HC-Prime-work/rig/`.

```bash
cd ~/Projects/rig-pilot
rig spec validate rig/pilot.yaml
rig up rig/pilot.yaml                     # first launch (later: rig up pilot)
rig ps --nodes --rig pilot                # seat states
rig send coord-lead-claude@pilot "…your request…"
rig queue list -a -A                      # task ownership / handoffs
rig down pilot --snapshot                 # stop (resume with: rig up pilot)
git worktree add .worktrees/<seat> -b agent/<seat>   # one worktree per new seat before adding it to a spec
agent-proxy-status [--recent 20]          # pool health / routing (not OpenRig)
jev-decide stats                          # Jev decisions (not OpenRig)
claude-pool                               # your own Claude Code session through the pool
agent-login <claude|codex> <label>        # re-authenticate one account
```

The OpenRig service only starts the daemon and the kernel rig at boot; project rigs start when you run `rig up`.

## Where things are

- Secrets (0600, never in git): `~/.config/agent-stack/secrets/{cliproxy.env,typesafe.env}`; OAuth tokens in `~/.cli-proxy-api/*.json`.
- Proxy config `~/.cli-proxy-api/config.yaml`; services `cliproxyapi`, `cliproxyapi-health.timer`, `cliproxy-usage.timer`, `openrig`, `openrig-health.timer` (user units, linger on).
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
- Provider terms may restrict pooling subscriptions through a proxy (risk accepted by the owner).

See `docs/ROLLBACK.md` and `docs/VALIDATION.md`.
