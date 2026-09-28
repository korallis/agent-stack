# Everything this setup installs

`install.sh` installs all of this. Versions are what the setup was last validated with (2026-09-28); plugins and MCP
servers marked "latest" track upstream, the rest are pinned in `config/versions.env`.

## Core programs

| What | Version | What it is for | Installed by |
|---|---|---|---|
| OpenRig (`rig`) | 0.5.17 (pinned) | Runs the teams: seats, queue, handoffs, reminders | `bin/openrig-upgrade`, kept current by `openrig-update` |
| CLIProxyAPI | 8.0.3 (pinned) | Pools Claude, ChatGPT and Kimi subscriptions with failover | download + sha256 check |
| Claude Code | latest via mise (validated 2.1.283) | Harness for Claude Opus / Fable and Kimi K3 seats | `mise use -g claude@latest` |
| Codex CLI | latest via mise (validated 0.157.1) | Harness for GPT-6 Sol / Astra seats | `mise use -g codex@latest` |
| Node.js | 26.8.2 global, 22 for OpenRig, 24 for Jev | Runtimes | mise |
| ripgrep, fd | system packages (validated 15.2.0, 10.5.0) | Fast, `.gitignore`-aware search for agents | your package manager |
| TOON CLI (`toon`) | latest (validated 4.1.1) | Compacts table-shaped JSON before it goes into prompts | `npm i -g @toon-format/cli` |
| Playwright + Chromium | latest (validated 1.63.0) | Real browser for user-journey tests and hands-on QA | `npx playwright install chromium` |

## Plugins and skills (loaded into every seat)

| What | Harness | Version | What it gives the agents |
|---|---|---|---|
| Superpowers | Claude Code | 6.4.1 (`superpowers@claude-plugins-official`) | Plan → failing test → build → verify discipline, subagent-driven development, code-review skills |
| Superpowers | Codex | `superpowers@openai-api-curated` | The same method for GPT seats |
| TypeSafe skill | Claude Code plugin `typesafe@typesafe-ai` 0.5.7; Codex `~/.agents/skills/typesafe-ai` | 0.5.7 | How to use Jev decisions well |
| agent-stack skill | both (`skills/agent-stack`, linked) | this repo | How this setup works: seats, pool, Jev |
| openrig-skills | both (copied from the OpenRig install) | OpenRig 0.5.17 | Operating OpenRig: recovery, handover, queue triage |

## MCP servers (tools the agents can call)

| Server | Harness | What it does |
|---|---|---|
| `jev` | Claude Code (user scope) and Codex | Typed decisions: routing, triage, merge gate (`jev/`, needs a TypeSafe key) |
| `playwright` | Claude Code (user scope) and Codex | Drives a real headless browser: QA seats use the app like a person |

## Background services (systemd user units)

| Unit | What it does |
|---|---|
| `cliproxyapi` | The subscription pool on 127.0.0.1:8317 |
| `openrig` | OpenRig daemon and its kernel rig |
| `cliproxyapi-health.timer`, `openrig-health.timer` | Restart the proxy / daemon if they stop answering |
| `cliproxy-usage.timer` | Records each request's account, model, status and quota (no content) |
| `cliproxy-authwatch.timer` | Alerts when one account keeps failing to sign in |
| `cliproxy-quotawatch.timer` | Warns at 80% of any account's 5-hour or weekly allowance |
| `openrig-update.timer` | Upgrades OpenRig from upstream when no project team is running, with validation and rollback |

## Accounts you add yourself

`gh auth login`, one `agent-login claude|codex|kimi <label>` per subscription, and a TypeSafe key in
`~/.config/agent-stack/secrets/typesafe.env`. None of these are ever stored in this repo.
