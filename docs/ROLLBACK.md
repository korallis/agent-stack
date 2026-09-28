# Rollback

Backups of every pre-existing file are in `~/.local/share/agent-stack/backups/<timestamp>/` (0700) plus
timestamped copies (`claude-settings.*.json`, `codex-config.*.toml`, `cpa-config.*.yaml`, `kernel-spec-orig-*`).

## Remove everything
```bash
systemctl --user disable --now openrig.service openrig-health.timer cliproxyapi.service cliproxyapi-health.timer cliproxy-usage.timer
rig down <each rig> --delete        # before stopping the daemon, if rigs are running
rm ~/.config/systemd/user/{openrig,openrig-health,cliproxyapi,cliproxyapi-health,cliproxy-usage}.{service,timer}
systemctl --user daemon-reload
claude plugin uninstall typesafe@typesafe-ai; claude plugin marketplace remove typesafe-ai
claude mcp remove --scope user jev; codex mcp remove jev
rm ~/.claude/skills/agent-stack ~/.agents/skills/agent-stack; rm -rf ~/.agents/skills/typesafe-ai
B=$(cat ~/.local/share/agent-stack/LAST_BACKUP)
cp $B/claude-settings.json ~/.claude/settings.json
rm ~/.codex/config.toml ~/.codex/pool-*.config.toml      # there was no config.toml before
# ~/.bashrc: delete the two "agent-stack env" lines (original in $B/bashrc)
rm ~/.local/bin/{rig,openrig-tui,cli-proxy-api,agent-*,jev-*,claude-pool,openrig-upgrade}
rm -rf ~/.local/share/agent-stack/{openrig,cliproxyapi,seat-bin} ~/.openrig ~/.cli-proxy-api   # removes pooled OAuth tokens
loginctl disable-linger lee    # only if nothing else needs linger
```
`rm -rf ~/.config/agent-stack/secrets` last, after revoking the TypeSafe key in the console if desired.

## Partial rollbacks
- **CLIProxyAPI 8.0.3 → 8.0.2:** `ln -sfn ~/.local/share/agent-stack/cliproxyapi/releases/8.0.2 ~/.local/share/agent-stack/cliproxyapi/current`,
  then `systemctl --user restart cliproxyapi` (8.0.2 is still unpacked; same config file).
- **CLIProxyAPI 8.0.2 → 7.3.20:** download the v7.3.20 release asset, verify with `checksums.txt`, unpack to
  `releases/7.3.20`, `ln -sfn releases/7.3.20 ~/.local/share/agent-stack/cliproxyapi/current`, `systemctl --user restart cliproxyapi`.
  v7 reads the v8 file's legacy fields; if not, restore a `cpa-config.*.yaml` backup.
- **OpenRig version:** `openrig-upgrade <version>`.
- **Claude direct (no pool) for seats:** remove the `OPENRIG_NODE_ID` block in `~/.config/agent-stack/env.sh`.
- **Codex back to ChatGPT login:** delete `model_provider = "cliproxyapi"` from `~/.codex/config.toml`, run `codex login`.
- **Seat shim:** remove `%h/.local/share/agent-stack/seat-bin:` from `Environment=PATH` in `openrig.service`.
- **YOLO off:** remove `permission_policy: builtin:yolo` from your RigSpec files (and `rig policy apply standard` on kernel specs),
  then recreate rigs; remove `skipDangerousModePermissionPrompt` from `~/.claude/settings.json`.
