### Changed
- CLIProxyAPI 8.0.3 → 8.0.10 (WO88). 8.0.3 sends a hard-coded Grok client version (`x-grok-client-version: 0.2.120`),
  which xAI now refuses ("Your Grok CLI version (0.2.120) is outdated … 1.0.13 or later"), so every Grok request through
  the proxy failed. 8.0.8 sends 1.0.44 (upstream #6252); 8.0.10 is the latest. The management endpoints agent-stack uses
  (`/credentials`, `/credentials/fields`, `/observability/usage/queue`) are unchanged; 8.0.5 removed only the
  `/credentials/quota/*` endpoints, which nothing here calls. Rollback: docs/ROLLBACK.md (8.0.3 stays unpacked).
