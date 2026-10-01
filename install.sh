#!/usr/bin/env bash
# install.sh: set up agent-stack on a Linux machine with a systemd user session.
# Safe to re-run: every step checks what is already there, backs up files it replaces, and never touches
# existing secrets, OAuth logins or proxy config. Clone this repo to ~/Projects/agent-stack first.
#   ./install.sh --apply    install / repair everything
#   ./install.sh --check    only report what is missing: writes nothing (no file, link, directory, mode or backup
#                           under $HOME or in this repo), starts and enables no unit, installs nothing
#   ./install.sh            asks first when run from a terminal; refused otherwise
#   ./install.sh --help     this text
# Any other argument is refused before anything runs. (It once meant a full install: `./install.sh --help` installed.)
set -euo pipefail
S=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
source "$S/config/versions.defaults.env"; [ -f "$S/config/versions.env" ] && source "$S/config/versions.env"   # tracked defaults, local override
PW_MCP=$(sed -n 's/.*"@playwright\/mcp@\([^"]*\)".*/\1/p' "$S/system/codex/config.toml" | head -1)   # the Playwright MCP pin
L=$HOME/.local/share/agent-stack; B=$HOME/.local/bin; C=$HOME/.config/agent-stack; SEC=$C/secrets
usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$S/install.sh"; }
CHECK="" ; for a in "$@"; do case $a in
  --check) [ "$CHECK" = 0 ] && { echo "install.sh: --check and --apply together; pick one. Nothing was done." >&2; exit 2; }; CHECK=1 ;;
  --apply) [ "$CHECK" = 1 ] && { echo "install.sh: --check and --apply together; pick one. Nothing was done." >&2; exit 2; }; CHECK=0 ;;
  -h|--help) usage; exit 0 ;;
  *) echo "install.sh: unknown argument '$a'. Nothing was done." >&2; usage >&2; exit 2 ;;
esac; done
if [ -z "$CHECK" ]; then   # no mode given: a full install only when a person at a terminal says yes
  if [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Install / repair agent-stack into $HOME? (--check only reports) [y/N] " yn
    case $yn in y|Y|yes|YES) CHECK=0 ;; *) echo "Nothing was done."; exit 1 ;; esac
  else echo "install.sh: say --apply to install or --check to report (no terminal to ask). Nothing was done." >&2; usage >&2; exit 2; fi
fi
# Never act on another HOME's OpenRig: a seat's OPENRIG_HOME (or a test that changed HOME but kept it) would point the
# daemon steps at a daemon this HOME doesn't own.
under_home() { case "$(realpath -m "$1")/" in "$(realpath -m "$HOME")/"*) return 0 ;; *) return 1 ;; esac; }
if [ -n "${OPENRIG_HOME:-}" ] && ! under_home "$OPENRIG_HOME"; then
  echo "install.sh: OPENRIG_HOME=$OPENRIG_HOME is not under HOME=$HOME; refusing (unset it or run with the HOME it belongs to). Nothing was done." >&2; exit 2
fi
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
[ $CHECK = 1 ] && echo "install.sh --check: report only, nothing is written or started" || echo "install.sh: installing / repairing"
ok()   { printf '   ok  %s\n' "$*"; }
todo() { printf '   --  %s\n' "$*"; }
backup() { if [ -e "$1" ] && [ ! -L "$1" ]; then cp -p "$1" "$1.bak-$(date +%Y%m%d%H%M%S)"; fi; }
render() { sed -e "s#@HOME@#$HOME#g; s#@AGENT_STACK@#$S#g" "$1"; }
place() { # place <rendered-source> <dest> [mode]: install a rendered file, backing up a different existing one
  local tmp; tmp=$(mktemp); render "$1" > "$tmp"
  if [ -f "$2" ] && cmp -s "$tmp" "$2"; then rm -f "$tmp"; ok "$2"; return; fi
  [ $CHECK = 1 ] && { rm -f "$tmp"; todo "$2 differs or missing"; return; }
  mkdir -p "$(dirname "$2")"; backup "$2"; install -m "${3:-644}" "$tmp" "$2"; rm -f "$tmp"; ok "$2 (installed)"
}
link() { if [ "$(readlink "$2" 2>/dev/null)" = "$1" ]; then ok "$2"; elif [ $CHECK = 1 ]; then todo "link $2"; else mkdir -p "$(dirname "$2")"; backup "$2"; ln -sfn "$1" "$2"; ok "$2 -> $1"; fi; }
# Directories this run needs, created only when installing (--check writes nothing, not even a directory).
dirs() { [ $CHECK = 1 ] || mkdir -p "$@"; }
launcher() { # launcher <name> <node-major> <script>: small wrapper pinned to a mise Node
  local node; node=$(mise where "node@$2")/bin/node
  local body="#!/usr/bin/env bash
exec \"$node\" \"$3\" \"\$@\""
  if [ -f "$B/$1" ] && [ "$(cat "$B/$1")" = "$body" ]; then ok "$B/$1"; elif [ $CHECK = 1 ]; then todo "$B/$1"; else printf '%s\n' "$body" > "$B/$1"; chmod 755 "$B/$1"; ok "$B/$1 (installed)"; fi
}

step "Prerequisites"
missing=()
for c in git gh jq tmux rg fd python3 curl tar sha256sum mise systemctl notify-send; do command -v "$c" >/dev/null || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "   missing: ${missing[*]}"
  echo "   Arch/Omarchy: sudo pacman -S git github-cli jq tmux ripgrep fd python curl mise libnotify"
  echo "   Debian/Ubuntu: sudo apt install git gh jq tmux ripgrep fd-find python3 curl libnotify-bin  (mise: https://mise.jdx.dev)"
  exit 1
fi
ok "git gh jq tmux rg fd python3 curl mise systemd notify-send"

step "Node, Claude Code and Codex (mise)"
if [ $CHECK = 0 ]; then
  mise use -g "node@$NODE_GLOBAL" claude@latest codex@latest gh@latest >/dev/null
  mise install "node@$NODE_FOR_OPENRIG" "node@$NODE_FOR_JEV" >/dev/null
fi
for t in "node@$NODE_GLOBAL" "node@$NODE_FOR_OPENRIG" "node@$NODE_FOR_JEV" claude codex; do mise where "$t" >/dev/null 2>&1 && ok "$t" || todo "$t"; done

step "Secrets (never in git)"
if [ $CHECK = 1 ]; then
  [ -d "$SEC" ] && [ "$(stat -c %a "$SEC")" = 700 ] && ok "$SEC (0700)" || todo "$SEC should be a 0700 directory"
else mkdir -p "$SEC"; chmod 700 "$SEC"; fi
if [ -s "$SEC/cliproxy.env" ]; then ok "$SEC/cliproxy.env"; elif [ $CHECK = 1 ]; then todo "$SEC/cliproxy.env"; else
  umask 077; printf 'CLIPROXY_CLIENT_KEY=sk-local-%s\nCLIPROXY_MGMT_KEY=%s\n' "$(python3 -c 'import secrets;print(secrets.token_hex(24))')" "$(python3 -c 'import secrets;print(secrets.token_hex(24))')" > "$SEC/cliproxy.env"
  ok "$SEC/cliproxy.env (new local proxy keys generated)"; fi
if [ -s "$SEC/typesafe.env" ]; then ok "$SEC/typesafe.env"; elif [ $CHECK = 1 ]; then todo "$SEC/typesafe.env (TypeSafe key for Jev)"; else
  umask 077; printf 'TYPESAFE_API_KEY=\n' > "$SEC/typesafe.env"; todo "$SEC/typesafe.env created empty: paste your TypeSafe key"; fi

step "CLIProxyAPI $CLIPROXY_VERSION"
arch=$(uname -m); case $arch in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac
R=$L/cliproxyapi/releases/$CLIPROXY_VERSION
if [ -x "$R/cli-proxy-api" ]; then ok "$R"; elif [ $CHECK = 1 ]; then todo "download CLIProxyAPI $CLIPROXY_VERSION"; else
  mkdir -p "$R"; base=https://github.com/router-for-me/CLIProxyAPI/releases/download/v$CLIPROXY_VERSION
  f=CLIProxyAPI_${CLIPROXY_VERSION}_linux_${arch}.tar.gz
  curl -fsSL -o "$R/$f" "$base/$f"; curl -fsSL -o "$R/checksums.txt" "$base/checksums.txt"
  (cd "$R" && grep " $f\$" checksums.txt | sha256sum -c -) && tar -xzf "$R/$f" -C "$R"; ok "$R (sha256 verified)"; fi
[ $CHECK = 1 ] || link "$R" "$L/cliproxyapi/current"
link "$L/cliproxyapi/current/cli-proxy-api" "$B/cli-proxy-api"
if [ -s "$HOME/.cli-proxy-api/config.yaml" ]; then ok "$HOME/.cli-proxy-api/config.yaml (kept as is)"; elif [ $CHECK = 1 ]; then todo "proxy config"; else
  source "$SEC/cliproxy.env"; mkdir -p "$HOME/.cli-proxy-api"; chmod 700 "$HOME/.cli-proxy-api"
  sed -e "s#\"sk-local-<redacted>\"#\"$CLIPROXY_CLIENT_KEY\"#; s#secret-key: \".*\"#secret-key: \"$CLIPROXY_MGMT_KEY\"#" "$S/system/cliproxyapi/config.yaml" > "$HOME/.cli-proxy-api/config.yaml"
  chmod 600 "$HOME/.cli-proxy-api/config.yaml"; ok "proxy config written (the proxy hashes the management key on first start)"; fi

step "Helper scripts"
dirs "$L/bin" "$L/seat-bin" "$B"
for f in agent-login cliproxy-healthcheck cliproxy-key openrig-healthcheck cliproxy-authwatch cliproxy-quotawatch agent-repos-sync; do place "$S/system/$f" "$L/bin/$f" 755; done
place "$S/system/seat-bin-codex" "$L/seat-bin/codex" 755
# Credential guard for seats' neon/vercel (refuses to print secrets into a transcript); env.sh adds the seat functions.
place "$S/system/seat-bin-credguard" "$L/seat-bin/credguard" 755
for f in neon neonctl vercel vc; do link "$L/seat-bin/credguard" "$L/seat-bin/$f"; done
dirs "$L/seat-tools"; place "$S/system/seat-tools-rig" "$L/seat-tools/rig" 755   # queue writes get the project tag + EC-3 worktree_path
link "$L/bin/agent-login" "$B/agent-login"
for f in claude-pool agent-heavy openrig-ensure playwright-browsers agent-claude-trust openrig-upgrade openrig-update agent-project-new agent-project-onboard agent-owner-address agent-project-check agent-net-summary agent-vercel-protection-status openrig-slack-upload-check agent-never-prompt-check agent-credguard-check agent-skills-check agent-seat-recap agent-seat-handover agent-human-inbox-tidy openrig-daemon-cycle openrig-tmux-adopt agent-queue-backfill agent-refresh-guidance agent-project-repair agent-waves-sync; do link "$S/bin/$f" "$B/$f"; done
link "$S/proxy/status.py" "$B/agent-proxy-status"
if [ $CHECK = 0 ] || mise where "node@$NODE_FOR_JEV" >/dev/null 2>&1; then
  launcher jev-mcp "$NODE_FOR_JEV" "$S/jev/bin/jev-mcp.js"
  launcher jev-decide "$NODE_FOR_JEV" "$S/jev/bin/jev-decide.js"
  launcher agent-recover "$NODE_FOR_JEV" "$S/orchestration/recover.js"
  launcher agent-dispatch "$NODE_FOR_JEV" "$S/orchestration/dispatch.js"
  launcher agent-merge-evidence "$NODE_FOR_JEV" "$S/orchestration/merge-evidence.js"
  launcher agent-stuck-check "$NODE_FOR_JEV" "$S/orchestration/stuck.js"
fi
if [ -d "$S/jev/node_modules" ]; then ok "jev dependencies"; elif [ $CHECK = 1 ]; then todo "jev npm ci"; else
  (cd "$S/jev" && PATH="$(mise where "node@$NODE_FOR_JEV")/bin:$PATH" npm ci --silent) && ok "jev dependencies installed"; fi

step "Shell environment and harness config"
place "$S/system/env.sh" "$C/env.sh"
link "$S/config/claude-proxy-settings.json" "$C/claude-proxy-settings.json"
if grep -qF '.config/agent-stack/env.sh' "$HOME/.bashrc" 2>/dev/null; then ok "~/.bashrc sources env.sh"; elif [ $CHECK = 1 ]; then todo "~/.bashrc hook"; else
  backup "$HOME/.bashrc"; { printf '# agent-stack (before the interactive guard so OpenRig seats get it too)\n[ -r "$HOME/.config/agent-stack/env.sh" ] && . "$HOME/.config/agent-stack/env.sh"\n\n'; cat "$HOME/.bashrc" 2>/dev/null; } > "$HOME/.bashrc.new" && mv "$HOME/.bashrc.new" "$HOME/.bashrc"; ok "~/.bashrc now sources env.sh"; fi
if [ -s "$HOME/.codex/config.toml" ]; then ok "$HOME/.codex/config.toml (kept; Codex adds machine-specific trust entries. Compare with system/codex/config.toml)"
  # Never prompt, even in a kept config: set the two top-level keys in place (backup first); --check only reports.
  if msg=$("$S/system/codex-never-prompt" $([ $CHECK = 1 ] && echo --check) "$HOME/.codex/config.toml"); then ok "$msg"; else todo "$msg"; fi
elif [ $CHECK = 1 ]; then todo "$HOME/.codex/config.toml"; else place "$S/system/codex/config.toml" "$HOME/.codex/config.toml" 600; fi
for p in pool-deep pool-impl pool-review; do place "$S/system/codex/$p.config.toml" "$HOME/.codex/$p.config.toml" 600; done
if [ $CHECK = 0 ]; then
  mkdir -p "$HOME/.claude"; [ -f "$HOME/.claude/settings.json" ] || echo '{}' > "$HOME/.claude/settings.json"
  # Claude never asks for permission: seats already get --dangerously-skip-permissions from builtin:yolo; this makes it the
  # default for every Claude session too, and skipDangerousModePermissionPrompt stops the bypass warning from exiting seats.
  tmp=$(mktemp); jq -s '.[0] * {skipDangerousModePermissionPrompt: true, permissions: ((.[0].permissions // {}) + {defaultMode: "bypassPermissions"})}' "$HOME/.claude/settings.json" > "$tmp" && mv "$tmp" "$HOME/.claude/settings.json"
fi
if jq -e '.skipDangerousModePermissionPrompt == true and .permissions.defaultMode == "bypassPermissions"' "$HOME/.claude/settings.json" >/dev/null 2>&1; then
  ok "~/.claude/settings.json: bypassPermissions + skipDangerousModePermissionPrompt"; else todo "~/.claude/settings.json: bypassPermissions + skipDangerousModePermissionPrompt"; fi
# Credential read guard: seats never stop for permission, so a PreToolUse hook (Claude: Bash|Read|Grep; Codex: Bash,
# trusted by hash) refuses a command or read that would print a credential file into the transcript. Local extra
# paths: one glob per line in $C/credguard-read-paths. Claude sessions pick it up live; Codex seats at next launch.
place "$S/system/credguard-read-hook" "$L/bin/agent-credguard-read-hook" 755
place "$S/system/credguard-read-install" "$L/bin/credguard-read-install" 755
while IFS= read -r line; do case "$line" in "ok "*) ok "${line#ok }" ;; *) todo "${line#-- }" ;; esac
done < <("$S/system/credguard-read-install" $([ $CHECK = 1 ] && echo --check) --hook "$L/bin/agent-credguard-read-hook" 2>&1 || true)
# Our skills (skills/*: agent-stack, openrig-project-setup and the workflow skills), linked for Claude and Codex, so
# every seat on the machine sees them.
for d in "$S"/skills/*/; do n=$(basename "$d"); link "$S/skills/$n" "$HOME/.claude/skills/$n"; link "$S/skills/$n" "$HOME/.agents/skills/$n"; done

step "systemd user services"
for u in "$S"/system/systemd/*.service "$S"/system/systemd/*.timer; do place "$u" "$HOME/.config/systemd/user/$(basename "$u")"; done
if [ $CHECK = 0 ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now cliproxyapi.service >/dev/null 2>&1 || todo "cliproxyapi.service failed to start: journalctl --user -u cliproxyapi"
  loginctl enable-linger "$USER" 2>/dev/null || todo "loginctl enable-linger $USER (lets services run when logged out)"
fi

step "OpenRig $OPENRIG_VERSION"
if [ $CHECK = 0 ]; then
  node22=$(mise where "node@$NODE_FOR_OPENRIG")/bin
  # Inside a seat, queue create/handoff go through seat-tools/rig first (project tag + EC-3 worktree_path).
  printf '#!/usr/bin/env bash\nif [ -n "${OPENRIG_NODE_ID:-}" ] && [ -z "${AGENT_STACK_RIG_HELPER:-}" ] && [ "${1:-}" = queue ] && [ -x "%s/seat-tools/rig" ]; then\n  case "${2:-}" in create|handoff|handoff-and-complete) exec "%s/seat-tools/rig" "$@" ;; esac\nfi\nexport PATH="%s:$PATH"\nexec "%s/openrig/bin/rig" "$@"\n' "$L" "$L" "$node22" "$L" > "$B/rig"; chmod 755 "$B/rig"
  # Never downgrade: install only when OpenRig is missing or the pin is NEWER; a newer install is kept and moves the pin.
  "$S/bin/openrig-ensure" | sed 's/^/   /'
  # Seats' tmux server gets its own unit first (skips itself if a server already runs; bin/openrig-tmux-adopt moves that one).
  systemctl --user enable --now openrig-tmux.service >/dev/null 2>&1 || todo "openrig-tmux.service"
  systemctl --user enable --now openrig.service >/dev/null 2>&1 || true
  for t in cliproxyapi-health cliproxy-usage openrig-health cliproxy-authwatch cliproxy-quotawatch openrig-update agent-repos-sync agent-human-inbox-tidy agent-stuck-check playwright-browsers; do systemctl --user enable --now "$t.timer" >/dev/null 2>&1 || todo "$t.timer"; done
fi
"$S/bin/openrig-ensure" --check | sed 's/^/   /' || true   # WARN installed != pin; FAIL when local patches aren't all applied
# Transcript capture defaults: every 15s, 400 lines. The shipped 2s/1000 lines across ~90 seats starved the daemon.
for kv in "transcripts.poll_interval_seconds 15" "transcripts.lines 400"; do
  set -- $kv
  if [ "$(env -u OPENRIG_TRANSCRIPTS_LINES -u OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS "$B/rig" config get "$1" 2>/dev/null)" = "$2" ]; then ok "$1 = $2"
  elif [ $CHECK = 1 ]; then todo "$1 should be $2"; else "$B/rig" config set "$1" "$2" >/dev/null 2>&1 && ok "$1 = $2 (set)" || todo "$1 = $2"; fi
done
# Stuck-sweep pickup threshold: OpenRig's default (3 min) paged "unclaimed" on rows a busy seat picks up minutes later
# (false positives, 2026-09-29). 480 min here; an existing value in config.json is kept, whatever it is.
cfg=${OPENRIG_HOME:-$HOME/.openrig}/config.json
have=$(jq -r '.queue.pickupStallThresholdMinutes // empty' "$cfg" 2>/dev/null || true)
if [ -n "$have" ]; then ok "queue.pickup_stall_threshold_minutes = $have (kept)"
elif [ $CHECK = 1 ]; then todo "queue.pickup_stall_threshold_minutes should be 480 (OpenRig's default of 3 min pages on busy seats)"
else "$B/rig" config set queue.pickup_stall_threshold_minutes 480 >/dev/null 2>&1 && ok "queue.pickup_stall_threshold_minutes = 480 (set)" || todo "queue.pickup_stall_threshold_minutes = 480"; fi
# OpenRig's own seat skills (mission-slice-sop, queue-handoff, compaction/continuity, ...). The rig specs name the
# openrig-core plugin, but seats are launched without --plugin-dir, so they only get these as user-level skills.
# Symlinks follow OpenRig upgrades.
orsk=$L/openrig/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core/skills
for d in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
  [ -d "$orsk" ] || { todo "OpenRig core skills (install OpenRig first)"; break; }
  missing=0; for s in "$orsk"/*/; do s=$(basename "$s"); [ -L "$d/$s" ] || missing=1; done
  if [ $missing = 0 ]; then ok "$d: OpenRig core skills"
  elif [ $CHECK = 1 ]; then todo "$d: OpenRig core skills"
  else mkdir -p "$d"; for s in "$orsk"/*/; do s=$(basename "$s"); [ -e "$d/$s" ] && [ ! -L "$d/$s" ] && { mkdir -p "$L/backups/skills"; mv "$d/$s" "$L/backups/skills/$(basename "$(dirname "$d")")-$s-$(date +%Y%m%d%H%M%S)"; }; ln -sfn "$orsk/$s" "$d/$s"; done; ok "$d: OpenRig core skills"; fi
done
# OpenRig's shared role agent: every template role agent references it as local:../../openrig-shared. A local link,
# never tracked (its target is under this machine's home); openrig-upgrade refreshes it on every upgrade.
orsh=$L/openrig/lib/node_modules/@openrig/cli/daemon/specs/agents/shared
if [ -d "$orsh" ]; then link "$orsh" "$S/rig/template/openrig-shared"; else todo "rig/template/openrig-shared (install OpenRig first)"; fi

step "OpenRig multi-project catalog"
U=$HOME/Projects/openrig-workspace
if [ -f "$U/workspace.yaml" ]; then ok "$U (catalog kept as is)"; elif [ $CHECK = 1 ]; then todo "$U catalog"; else
  mkdir -p "$U/missions" "$U/exhaust"; cp "$S/config/openrig-workspace/"{SPEC.md,workspace.yaml} "$U/"
  "$B/rig" config init-workspace --root "$U" >/dev/null 2>&1 || true
  for kv in "workspace.root $U" "workspace.slices_root $U/missions" "workspace.catalog_path $U/workspace.yaml" "files.allowlist workspace:$U" "progress.scan_roots workspace:$U"; do "$B/rig" config set $kv >/dev/null 2>&1 || true; done
  "$S/bin/openrig-daemon-cycle" --reason "install.sh: new umbrella workspace" >/dev/null 2>&1 || todo "restart the OpenRig daemon: openrig-daemon-cycle"; ok "$U created; OpenRig points at it (add each project to its workspace.yaml)"; fi

step "Agent tools: plugins, MCP servers, browsers"
if [ $CHECK = 0 ]; then
  claude plugin marketplace add typesafe-ai/skills >/dev/null 2>&1 || true
  claude plugin install typesafe@typesafe-ai >/dev/null 2>&1 || todo "claude plugin typesafe@typesafe-ai"
  claude plugin install superpowers@claude-plugins-official >/dev/null 2>&1 || todo "claude plugin superpowers"
  claude plugin install vercel@claude-plugins-official >/dev/null 2>&1 || todo "claude plugin vercel@claude-plugins-official"
  codex plugin add superpowers@openai-api-curated >/dev/null 2>&1 || todo "codex plugin superpowers"
  # Codex has no Claude plugins: it gets the plugin's typesafe-ai skill as a copy, refreshed when the plugin updates.
  # The source is the version Claude has installed (installed_plugins.json), never whichever cache dir sorts last.
  ts=$(jq -r '[.plugins["typesafe@typesafe-ai"][]? | select(.scope == "user")][0].installPath // empty' \
    "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null || true)
  ts=${ts:+$ts/skills/typesafe-ai}
  if [ -n "$ts" ] && [ -f "$ts/SKILL.md" ] && ! diff -rq "$ts" "$HOME/.agents/skills/typesafe-ai" >/dev/null 2>&1; then
    mkdir -p "$HOME/.agents/skills" "$L/backups/skills"
    [ -e "$HOME/.agents/skills/typesafe-ai" ] && mv "$HOME/.agents/skills/typesafe-ai" "$L/backups/skills/agents-typesafe-ai-$(date +%Y%m%d%H%M%S)"
    cp -r "$ts" "$HOME/.agents/skills/"
  fi
  claude mcp get jev >/dev/null 2>&1 || claude mcp add --scope user jev -- "$B/jev-mcp" >/dev/null
  # Playwright MCP: the pinned release with Playwright's own Chrome for Testing (see system/codex/config.toml). An
  # existing user-scope entry with other args (the old @latest + --executable-path) is replaced.
  # --output-dir: outside every repo; its net/ subdir (0700) holds the network/console logs the credential guard
  # protects (WO57: they carry runtime tokens; seats read them through agent-net-summary).
  PWO="$HOME/.local/state/agent-stack/playwright-mcp"; mkdir -p "$PWO/net"; chmod 700 "$PWO/net"
  pw=(npx -y "@playwright/mcp@$PW_MCP" --headless --browser chromium --secrets "$SEC/playwright.env" --output-dir "$PWO")
  "$S/system/playwright-mcp-config" | sed 's/^/   /'   # secrets file (0600) + the Codex MCP args with --secrets
  if ! claude mcp get playwright 2>/dev/null | grep -qF -- "Args: ${pw[*]:1}"; then
    claude mcp remove --scope user playwright >/dev/null 2>&1 || true
    claude mcp add --scope user playwright -- "${pw[@]}" >/dev/null || todo "claude mcp playwright"
  fi
  command -v toon >/dev/null || npm install -g @toon-format/cli >/dev/null 2>&1
  # Neon: CLI (preferred by agents), the Postgres/branching skills, and the OAuth MCP server for Claude Code.
  # Codex's Neon MCP entry comes from system/codex/config.toml (neon's own installer would rewrite that file).
  command -v neon >/dev/null || npm install -g neon >/dev/null 2>&1
  command -v neon >/dev/null && neon skills --global -y -a claude-code -a codex \
    -s neon -s neon-postgres -s neon-postgres-branches -s neon-postgres-egress-optimizer >/dev/null 2>&1 || todo "neon skills"
  claude mcp get Neon >/dev/null 2>&1 || claude mcp add --scope user --transport http Neon https://mcp.neon.tech/mcp >/dev/null
  "$S/bin/playwright-browsers" >/dev/null || todo "playwright chromium for @playwright/mcp@$PW_MCP"
fi
# Claude Code and Codex write their own state (~/.claude.json, ~/.codex/) the first time they run in a HOME, so --check
# asks them only where they have run before (a later run changes nothing; measured).
asks() { [ $CHECK = 0 ] || [ -e "$1" ]; }
if asks "$HOME/.claude.json"; then
claude plugin list 2>/dev/null | grep -q superpowers && ok "Superpowers (Claude Code)" || todo "Superpowers (Claude Code)"
claude mcp get playwright 2>/dev/null | grep -qF -- "Args: -y @playwright/mcp@$PW_MCP --headless --browser chromium --secrets $SEC/playwright.env --output-dir $HOME/.local/state/agent-stack/playwright-mcp" \
  && ok "Playwright MCP (Claude Code): @playwright/mcp@$PW_MCP, Chrome for Testing, --secrets, --output-dir" || todo "WARN: Playwright MCP (Claude Code) not on @playwright/mcp@$PW_MCP --browser chromium --secrets $SEC/playwright.env --output-dir ~/.local/state/agent-stack/playwright-mcp"
else todo "Claude Code has not run in this HOME yet (no ~/.claude.json): its plugins and MCP servers can't be checked without it writing that"; fi
"$S/system/playwright-mcp-config" --check | sed 's/^/   /' || true   # secrets file 0600 + Codex args with --secrets
"$S/bin/playwright-browsers" --check >/dev/null && ok "Playwright MCP browser installed" || todo "Playwright MCP browser: run playwright-browsers"
if asks "$HOME/.codex"; then codex plugin list 2>/dev/null | grep -q "superpowers.*installed" && ok "Superpowers (Codex)" || todo "Superpowers (Codex)"
else todo "Codex has not run in this HOME yet (no ~/.codex): its plugins can't be checked without it writing there"; fi
command -v toon >/dev/null && ok "toon CLI" || todo "toon CLI"
command -v neon >/dev/null && ok "Neon CLI + skills" || todo "Neon CLI (npm i -g neon; then neon login)"

step "Owner address (the human seats message)"
own=$("$S/bin/agent-owner-address" --source 2>/dev/null || echo "owner@external (default)"); addr=${own%% *}
# The file judged on its own, without the environment override (AGENT_OWNER_ADDRESS may be set as well).
fileown=$(env -u AGENT_OWNER_ADDRESS "$S/bin/agent-owner-address" --source 2>/dev/null || true)
if [ -e "$S/config/owner.env" ] && [ "${fileown#* }" != "(config/owner.env)" ]; then
  todo "owner address: $S/config/owner.env has no valid OWNER_ADDRESS=<name>@external (using $own); fix that line"
elif [ -e "$S/config/owner.env" ]; then
  if [ "${own#* }" = "(AGENT_OWNER_ADDRESS)" ]; then ok "owner address: $addr (AGENT_OWNER_ADDRESS overrides config/owner.env: ${fileown%% *})"
  else ok "owner address: $own"; fi
elif [ "${own#* }" = "(default)" ]; then todo "owner address: none registered yet; register yourself (rig gateway human add) or put OWNER_ADDRESS=<you>@external in $S/config/owner.env"
elif [ $CHECK = 1 ]; then todo "owner address: $own, not recorded in config/owner.env yet (./install.sh --apply records it)"
else printf '# The owner'"'"'s human address, the one seats message (agent-owner-address). Per machine; not tracked.\nOWNER_ADDRESS=%s\n' "$addr" > "$S/config/owner.env"
  ok "owner address: $addr recorded in config/owner.env"; fi

step "Kernel operator: the project-onboarding pointer"
og=(); [ $CHECK = 1 ] && og=(--check)
{ "$S/system/operator-guidance" "${og[@]}" || true; } | while IFS= read -r l; do case $l in "ok   "*) ok "${l#ok   }";; *) todo "${l#--   }";; esac; done

step "Skills (one line per source; docs/SKILLS.md)"
{ "$S/bin/agent-skills-check" || true; } | while IFS= read -r l; do   # its WARN exit must not stop install.sh
  case $l in "ok  "*) ok "${l#ok    }";; WARN*) todo "WARN: ${l#WARN  }";; *) printf '   %s\n' "$l";; esac
done

step "Next, by hand (logins cannot be scripted)"
cat <<EOF
   1. Open a new terminal (loads env.sh).
   2. gh auth login
   3. Pool your subscriptions, one per account, each in a private browser window:
        agent-login claude claude-a     agent-login codex codex-a     agent-login kimi kimi-a
   4. Paste your TypeSafe key into $SEC/typesafe.env (Jev), then: openrig-daemon-cycle
   5. Start a project: see starter-kit/README.md
   Re-run ./install.sh --check at any time to see what is missing.
EOF
