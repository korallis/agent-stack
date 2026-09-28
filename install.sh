#!/usr/bin/env bash
# install.sh: set up agent-stack on a Linux machine with a systemd user session.
# Safe to re-run: every step checks what is already there, backs up files it replaces, and never touches
# existing secrets, OAuth logins or proxy config. Clone this repo to ~/Projects/agent-stack first.
#   ./install.sh            install / repair everything
#   ./install.sh --check    only report what is missing
set -euo pipefail
S=$(cd "$(dirname "$(readlink -f "$0")")" && pwd); source "$S/config/versions.env"
L=$HOME/.local/share/agent-stack; B=$HOME/.local/bin; C=$HOME/.config/agent-stack; SEC=$C/secrets
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
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
link() { mkdir -p "$(dirname "$2")"; if [ "$(readlink "$2" 2>/dev/null)" = "$1" ]; then ok "$2"; elif [ $CHECK = 1 ]; then todo "link $2"; else backup "$2"; ln -sfn "$1" "$2"; ok "$2 -> $1"; fi; }
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
mkdir -p "$SEC"; chmod 700 "$SEC"
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
mkdir -p "$L/bin" "$L/seat-bin" "$B"
for f in agent-login cliproxy-healthcheck cliproxy-key openrig-healthcheck cliproxy-authwatch; do place "$S/system/$f" "$L/bin/$f" 755; done
place "$S/system/seat-bin-codex" "$L/seat-bin/codex" 755
link "$L/bin/agent-login" "$B/agent-login"
for f in claude-pool agent-heavy openrig-upgrade openrig-update; do link "$S/bin/$f" "$B/$f"; done
link "$S/proxy/status.py" "$B/agent-proxy-status"
if [ $CHECK = 0 ] || mise where "node@$NODE_FOR_JEV" >/dev/null 2>&1; then
  launcher jev-mcp "$NODE_FOR_JEV" "$S/jev/bin/jev-mcp.js"
  launcher jev-decide "$NODE_FOR_JEV" "$S/jev/bin/jev-decide.js"
  launcher agent-recover "$NODE_FOR_JEV" "$S/orchestration/recover.js"
  launcher agent-dispatch "$NODE_FOR_JEV" "$S/orchestration/dispatch.js"
fi
if [ -d "$S/jev/node_modules" ]; then ok "jev dependencies"; elif [ $CHECK = 1 ]; then todo "jev npm ci"; else
  (cd "$S/jev" && PATH="$(mise where "node@$NODE_FOR_JEV")/bin:$PATH" npm ci --silent) && ok "jev dependencies installed"; fi

step "Shell environment and harness config"
place "$S/system/env.sh" "$C/env.sh"
link "$S/config/claude-proxy-settings.json" "$C/claude-proxy-settings.json"
if grep -qF '.config/agent-stack/env.sh' "$HOME/.bashrc" 2>/dev/null; then ok "~/.bashrc sources env.sh"; elif [ $CHECK = 1 ]; then todo "~/.bashrc hook"; else
  backup "$HOME/.bashrc"; { printf '# agent-stack (before the interactive guard so OpenRig seats get it too)\n[ -r "$HOME/.config/agent-stack/env.sh" ] && . "$HOME/.config/agent-stack/env.sh"\n\n'; cat "$HOME/.bashrc" 2>/dev/null; } > "$HOME/.bashrc.new" && mv "$HOME/.bashrc.new" "$HOME/.bashrc"; ok "~/.bashrc now sources env.sh"; fi
if [ -s "$HOME/.codex/config.toml" ]; then ok "$HOME/.codex/config.toml (kept; Codex adds machine-specific trust entries. Compare with system/codex/config.toml)"
elif [ $CHECK = 1 ]; then todo "$HOME/.codex/config.toml"; else place "$S/system/codex/config.toml" "$HOME/.codex/config.toml" 600; fi
for p in pool-deep pool-impl pool-review; do place "$S/system/codex/$p.config.toml" "$HOME/.codex/$p.config.toml" 600; done
if [ $CHECK = 0 ]; then
  mkdir -p "$HOME/.claude"; [ -f "$HOME/.claude/settings.json" ] || echo '{}' > "$HOME/.claude/settings.json"
  tmp=$(mktemp); jq -s '.[0] * {skipDangerousModePermissionPrompt: true}' "$HOME/.claude/settings.json" > "$tmp" && mv "$tmp" "$HOME/.claude/settings.json"
fi
ok "~/.claude/settings.json: skipDangerousModePermissionPrompt"
link "$S/skills/agent-stack" "$HOME/.claude/skills/agent-stack"
link "$S/skills/agent-stack" "$HOME/.agents/skills/agent-stack"

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
  printf '#!/usr/bin/env bash\nexport PATH="%s:$PATH"\nexec "%s/openrig/bin/rig" "$@"\n' "$node22" "$L" > "$B/rig"; chmod 755 "$B/rig"
  if [ "$("$B/rig" --version 2>/dev/null | awk '{print $1}')" != "$OPENRIG_VERSION" ]; then "$S/bin/openrig-upgrade" "$OPENRIG_VERSION"; fi
  systemctl --user enable --now openrig.service >/dev/null 2>&1 || true
  for t in cliproxyapi-health cliproxy-usage openrig-health cliproxy-authwatch openrig-update; do systemctl --user enable --now "$t.timer" >/dev/null 2>&1 || todo "$t.timer"; done
fi
"$B/rig" --version >/dev/null 2>&1 && ok "rig $("$B/rig" --version | awk '{print $1}')" || todo "OpenRig not installed"
for d in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
  src=$L/openrig/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core/skills/openrig-skills
  [ -d "$src" ] && { [ -d "$d/openrig-skills" ] && ok "$d/openrig-skills" || { [ $CHECK = 1 ] && todo "$d/openrig-skills" || { mkdir -p "$d"; cp -r "$src" "$d/"; ok "$d/openrig-skills"; }; }; }
done

step "Agent tools: plugins, MCP servers, browsers"
if [ $CHECK = 0 ]; then
  claude plugin marketplace add typesafe-ai/skills >/dev/null 2>&1 || true
  claude plugin install typesafe@typesafe-ai >/dev/null 2>&1 || todo "claude plugin typesafe@typesafe-ai"
  claude plugin install superpowers@claude-plugins-official >/dev/null 2>&1 || todo "claude plugin superpowers"
  codex plugin add superpowers@openai-api-curated >/dev/null 2>&1 || todo "codex plugin superpowers"
  ts=$(ls -d "$HOME"/.claude/plugins/cache/typesafe-ai/typesafe/*/skills/typesafe-ai 2>/dev/null | tail -1)
  [ -n "$ts" ] && [ ! -e "$HOME/.agents/skills/typesafe-ai" ] && { mkdir -p "$HOME/.agents/skills"; cp -r "$ts" "$HOME/.agents/skills/"; }
  claude mcp get jev >/dev/null 2>&1 || claude mcp add --scope user jev -- "$B/jev-mcp" >/dev/null
  claude mcp get playwright >/dev/null 2>&1 || claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest --headless >/dev/null
  codex mcp get playwright >/dev/null 2>&1 || codex mcp add playwright -- npx -y @playwright/mcp@latest --headless >/dev/null
  command -v toon >/dev/null || npm install -g @toon-format/cli >/dev/null 2>&1
  npx -y playwright@latest install chromium >/dev/null 2>&1 || todo "playwright chromium"
fi
claude plugin list 2>/dev/null | grep -q superpowers && ok "Superpowers (Claude Code)" || todo "Superpowers (Claude Code)"
codex plugin list 2>/dev/null | grep -q "superpowers.*installed" && ok "Superpowers (Codex)" || todo "Superpowers (Codex)"
command -v toon >/dev/null && ok "toon CLI" || todo "toon CLI"

step "Next, by hand (logins cannot be scripted)"
cat <<EOF
   1. Open a new terminal (loads env.sh).
   2. gh auth login
   3. Pool your subscriptions, one per account, each in a private browser window:
        agent-login claude claude-a     agent-login codex codex-a     agent-login kimi kimi-a
   4. Paste your TypeSafe key into $SEC/typesafe.env (Jev), then: systemctl --user restart openrig.service
   5. Start a project: see starter-kit/README.md
   Re-run ./install.sh --check at any time to see what is missing.
EOF
