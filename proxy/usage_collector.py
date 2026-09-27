#!/usr/bin/env python3
"""Drain CLIProxyAPI's in-memory usage queue into a redacted JSONL routing log.

The management queue is pop-on-read and expires after `redis-usage-queue-retention-seconds`,
so this runs every 30s from a systemd timer. Only routing metadata is kept: account label,
provider, model, status, latency, token counts and quota signals. Never tokens, prompts or bodies.
"""
import json, os, pathlib, urllib.request

BASE = "http://127.0.0.1:8317/v8/management"
LOG = pathlib.Path.home() / ".local/share/agent-stack/logs/proxy-usage.jsonl"
QUOTA_KEYS = (
    "Anthropic-Ratelimit-Unified-5h-Utilization", "Anthropic-Ratelimit-Unified-7d-Utilization",
    "Anthropic-Ratelimit-Unified-Status", "Anthropic-Ratelimit-Unified-Overage-Status",
    "X-Codex-Primary-Used-Percent", "X-Codex-Secondary-Used-Percent", "X-Codex-Plan-Type",
    "X-Codex-Credits-Has-Credits",
)


def mgmt_key() -> str:
    for line in (pathlib.Path.home() / ".config/agent-stack/secrets/cliproxy.env").read_text().splitlines():
        if line.startswith("CLIPROXY_MGMT_KEY="):
            return line.split("=", 1)[1]
    raise SystemExit("CLIPROXY_MGMT_KEY missing")


def get(path: str, key: str):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def main() -> None:
    key = mgmt_key()
    labels = {f["auth_index"]: (f.get("note") or f.get("label"), f.get("provider")) for f in get("/credentials", key)["files"]}
    events = get("/observability/usage/queue?count=1000", key) or []
    if not events:
        return
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as out:
        for e in events:
            label, provider = labels.get(e.get("auth_index"), ("unknown", None))
            hdr = e.get("response_headers") or {}
            out.write(json.dumps({
                "ts": e.get("timestamp"), "account": label, "provider": provider, "auth_index": e.get("auth_index"),
                "model": e.get("model"), "failed": e.get("failed"), "status": (e.get("fail") or {}).get("status_code"),
                "stream": e.get("stream"), "latency_ms": e.get("latency_ms"), "ttft_ms": e.get("ttft_ms"),
                "user_agent": (e.get("user_agent") or "")[:60], "tokens": e.get("tokens"),
                "quota": {k: hdr[k][0] for k in QUOTA_KEYS if k in hdr},
            }) + "\n")
    os.chmod(LOG, 0o600)


if __name__ == "__main__":
    main()
