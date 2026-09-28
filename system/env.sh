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
