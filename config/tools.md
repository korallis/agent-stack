# Everything this setup installs

`install.sh` installs all of this. Versions are what the setup was last validated with (2026-09-28); plugins and MCP
servers marked "latest" track upstream, the rest are pinned in `config/versions.env`.

## Core programs

| What | Version | What it is for | Installed by |
|---|---|---|---|
| OpenRig (`rig`) | 0.5.17 (pinned) | Runs the teams: seats, queue, handoffs, reminders | `bin/openrig-upgrade`, kept current by `openrig-update` |
| CLIProxyAPI | 8.0.3 (pinned) | Pools Claude, ChatGPT and Kimi subscriptions with failover | download + sha256 check |
| Claude Code | latest via mise (validated 2.1.283) | Harness for Claude Opus / Fable and Kimi K3 seats | `mise use -g claude@latest` |
| Codex CLI | latest via mise (validated 0.157.1) | Harness for GPT-6.1 Sol seats | `mise use -g codex@latest` |
| Node.js | 26.8.2 global, 22 for OpenRig, 24 for Jev | Runtimes | mise |
| ripgrep, fd | system packages (validated 15.2.0, 10.5.0) | Fast, `.gitignore`-aware search for agents | your package manager |
| TOON CLI (`toon`) | latest (validated 4.1.1) | Compacts table-shaped JSON before it goes into prompts | `npm i -g @toon-format/cli` |
| Neon CLI (`neon`) | latest (validated 6.3.0) | Neon database branches (one per PR), inspection, restore. Sign in once with `neon login` | `npm i -g neon` |
| Playwright + Chromium | latest (validated 1.63.0) | Real browser for user-journey tests and hands-on QA | `npx playwright install chromium` |
| `agent-project-new` / `-check` / `-repair`, `agent-waves-sync`, `agent-queue-backfill`, `agent-refresh-guidance` | this repo (`bin/`) | Set up a project the OpenRig way; audit it against what the daemon/TUI reads; repair it; keep waves, queue rows and seat instructions right | install.sh links them into `~/.local/bin` |
| Grok Build CLI (`grok` / `grokbuild`) | optional, from xAI | Quota for Grok seats. `agent-harness-status` runs `grok usage --json` (or `grokbuild`). Sign in with `grok login` | you, then `./install.sh --check` reports it |
| Kimi Code CLI (`kimi`) | optional (`@moonshot-ai/kimi-code`) | Quota for Kimi. `agent-harness-status` runs `kimi usage --json`. Sign in with `kimi login`. `agent-login kimi` is the proxy seat only | `npm i -g @moonshot-ai/kimi-code` |
| `agent-harness-status` | this repo (`harness/status.js`) | Reads grokbuild and kimi usage for rig-console. Never invents a percent | install.sh launcher |

## Plugins and skills (loaded into every seat)

| What | Harness | Version | What it gives the agents |
|---|---|---|---|
| Superpowers | Claude Code | 6.4.1 (`superpowers@claude-plugins-official`) | Plan → failing test → build → verify discipline, subagent-driven development, code-review skills |
| Superpowers | Codex | `superpowers@openai-api-curated` | The same method for GPT seats |
| TypeSafe skill | Claude Code plugin `typesafe@typesafe-ai` 0.5.7; Codex `~/.agents/skills/typesafe-ai` | 0.5.7 | How to use Jev decisions well |
| openrig-project-setup skill | both (`skills/openrig-project-setup`, linked) | this repo | How to set up, audit and repair a project; the mistakes made before and what prevents them |
| agent-stack skill | both (`skills/agent-stack`, linked) | this repo | How this setup works: seats, pool, Jev |
| Neon skills (`neon`, `neon-postgres`, `neon-postgres-branches`, `neon-postgres-egress-optimizer`) | both (`~/.agents/skills`, linked into `~/.claude/skills`) | latest (`neon skills update`) | How to use Neon Postgres well: connections, migrations, branch-per-PR testing, cost |
| OpenRig core skills (19: `mission-slice-sop`, `queue-handoff`, `seat-continuity-and-handover`, `claude-compaction-restore`, `openrig-skills`, ...) | both (symlinked from the OpenRig install; follow upgrades) | OpenRig 0.5.17 | Missions/slices/waves, handoffs, compaction and seat continuity. Seats would otherwise miss them: the rig specs' openrig-core plugin isn't loaded |

## MCP servers (tools the agents can call)

| Server | Harness | What it does |
|---|---|---|
| `jev` | Claude Code (user scope) and Codex | Typed decisions: routing, triage, merge gate (`jev/`, needs a TypeSafe key) |
| `playwright` | Claude Code (user scope) and Codex | Drives a real headless browser: QA seats use the app like a person |
| `Neon` | Claude Code (user scope) and Codex | Neon's hosted MCP (OAuth). Optional: agents use the `neon` CLI first |

## Helpers (seats and repos)

| Helper | Where | What it does |
|---|---|---|
| `seat-tools/rig` | seats (via the `rig` launcher; outside a seat, `queue create` only) | Every `rig queue create/handoff` gets the `project:<id>` tag and the `worktree_path=` line OpenRig's project views join on; a row to a human (`*@external`) without `--summary` gets one from the body's first line, so Slack never shows "(no summary)" |
| `pre-commit` git hook | each project repo (installed by agent-project-new) | Refuses commits containing OpenRig seat instruction blocks (`system/git-hooks/pre-commit`) |

## Background services (systemd user units)

| Unit | What it does |
|---|---|
| `cliproxyapi` | The subscription pool on 127.0.0.1:8317 |
| `openrig` | OpenRig daemon and its kernel rig |
| `cliproxyapi-health.timer`, `openrig-health.timer` | Restart the proxy / daemon if they stop answering |
| `cliproxy-usage.timer` | Records each request's account, model, status and quota (no content) |
| `cliproxy-authwatch.timer` | Alerts when one account keeps failing to sign in |
| `cliproxy-quotawatch.timer` | Warns at 80% of any account's 5-hour or weekly allowance; Codex windows by their length; accounts on credits get a daily low note, never a stall alert |
| `agent-repos-sync.timer` | Fast-forwards every project's shared checkout to origin/main every 5 minutes (OpenRig judges 'merged' against it) |
| `openrig-update.timer` | Upgrades OpenRig from upstream when no project team is running, with validation and rollback |

## Accounts you add yourself

`gh auth login`, `neon login`, one `agent-login claude|codex|kimi <label>` per subscription, a TypeSafe key in
`~/.config/agent-stack/secrets/typesafe.env`, and (for harness quota) `grok login` plus `kimi login` after those
CLIs are installed. None of these are ever stored in this repo.
