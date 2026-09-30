# agent-stack global environment (sourced from ~/.bashrc for interactive AND non-interactive shells).
# Secrets live in ~/.config/agent-stack/secrets (0600); only TYPESAFE_API_KEY is exported so the
# TypeSafe SDK/skill works in Claude Code, Codex and OpenRig seats. The proxy key is never exported.
if [ -r "$HOME/.config/agent-stack/secrets/typesafe.env" ]; then
  export TYPESAFE_API_KEY="$(sed -n 's/^TYPESAFE_API_KEY=//p' "$HOME/.config/agent-stack/secrets/typesafe.env")"
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac

# OpenRig-managed seats only (the daemon sets OPENRIG_NODE_ID via `tmux -e` on every seat pane):
# route Claude Code through the local CLIProxyAPI pool. Codex seats use ~/.codex/config.toml.
# Your own interactive `claude` (no OPENRIG_NODE_ID) keeps direct claude.ai login + connectors.
if [ -n "${OPENRIG_NODE_ID:-}" ] && [ -r "$HOME/.config/agent-stack/secrets/cliproxy.env" ]; then
  export ANTHROPIC_BASE_URL="http://127.0.0.1:8317"
  export ANTHROPIC_AUTH_TOKEN="$(sed -n 's/^CLIPROXY_CLIENT_KEY=//p' "$HOME/.config/agent-stack/secrets/cliproxy.env")"
  export API_TIMEOUT_MS=600000
  export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5
  export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5
  export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001
  export ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-1
  # Kimi K3 through the proxy: use model "kimi-k3[1m]" for the 1M window. "kimi-k3-256k" is not a model
  # Claude Code recognises, so this sets its window (it does not affect claude-* or [1m] model IDs).
  export CLAUDE_CODE_MAX_CONTEXT_TOKENS=256000
  # Seats talk only to the local proxy: no telemetry, error reporting, auto-update or feedback traffic.
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
fi

# Many seats run app/test servers at once: give each seat its own port (20000-29999, stable per seat folder).
# The starter kit's Playwright config serves the app on it and never reuses a server it did not start.
if [ -n "${OPENRIG_NODE_ID:-}" ] && [ -z "${E2E_PORT:-}" ]; then
  export E2E_PORT=$(( 20000 + $(printf %s "$PWD" | cksum | cut -d' ' -f1) % 10000 ))
fi

# Several projects at once: each OpenRig seat runs in ~/Projects/<Project>.worktrees/<seat>. Point its
# `rig scope` / `rig proof` commands at that project's own workspace (~/Projects/<Project>-work) instead of the
# single machine-wide workspace.root, so every project keeps its own missions and slices.
if [ -n "${OPENRIG_NODE_ID:-}" ] && [ -z "${OPENRIG_WORK_ROOT:-}" ]; then
  case "$PWD" in
    "$HOME"/Projects/*.worktrees/*)
      _p=${PWD#"$HOME/Projects/"}; _p=${_p%%.worktrees/*}
      [ -d "$HOME/Projects/$_p-work/missions" ] && export OPENRIG_WORK_ROOT="$HOME/Projects/$_p-work"
      unset _p ;;
  esac
fi
# Seats: seat tools (a `rig` that adds the project tag + worktree to queue writes) come first on PATH.
if [ -n "${OPENRIG_NODE_ID:-}" ] && [ -d "$HOME/.local/share/agent-stack/seat-tools" ]; then
  case ":$PATH:" in *":$HOME/.local/share/agent-stack/seat-tools:"*) ;; *) export PATH="$HOME/.local/share/agent-stack/seat-tools:$PATH" ;; esac
fi
# Seats: the credential guard (seat-bin/credguard) in front of the Neon and Vercel CLIs, as shell functions so it wins
# over any PATH order (mise puts the real CLIs first in interactive shells). It refuses to print connection strings,
# passwords and tokens into the seat's output, i.e. its transcript (2026-09-30).
if [ -n "${OPENRIG_NODE_ID:-}" ] && [ -x "$HOME/.local/share/agent-stack/seat-bin/credguard" ]; then
  neon() { "$HOME/.local/share/agent-stack/seat-bin/neon" "$@"; }
  neonctl() { "$HOME/.local/share/agent-stack/seat-bin/neonctl" "$@"; }
  vercel() { "$HOME/.local/share/agent-stack/seat-bin/vercel" "$@"; }
  vc() { "$HOME/.local/share/agent-stack/seat-bin/vc" "$@"; }
fi
# Seats: use the Node major the project asks for (.node-version / .nvmrc in the worktree), newest installed
# patch of it, ahead of the daemon's Node 22 and the global mise Node. Projects without the file are untouched.
if [ -n "${OPENRIG_NODE_ID:-}" ]; then
  for _f in .node-version .nvmrc; do
    [ -f "$PWD/$_f" ] || continue
    _maj=$(tr -d 'v \r\n' < "$PWD/$_f" | cut -d. -f1)
    _b=$(ls -d "$HOME"/.local/share/mise/installs/node/"$_maj".*/bin 2>/dev/null | sort -V | tail -1)
    if [ -n "$_maj" ] && [ -x "$_b/node" ] && [ "${PATH%%:*}" != "$_b" ]; then export PATH="$_b:$PATH"; fi
    break
  done
  unset _f _maj _b
fi
