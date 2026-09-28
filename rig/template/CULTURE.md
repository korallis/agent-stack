# Team culture (shared by every repo's rig)

- The repository's own AGENTS.md / AGENT_WORKFLOW.md / CONTRIBUTING.md are binding. When they conflict with anything here, they win.
- One owner per queue item and per worktree. Claim before working; hand off explicitly (`rig queue claim` / `rig queue handoff`).
- The repo's tracker (issues/project, task docs) is the source of truth for status. OpenRig slices point to it.
- Only Ready work is started. Blocked work stays blocked until its dependency is really done.
- Pull requests are ready (never drafts) and reviewed by a seat that did not author them, preferring the other model family.
- One merge owner (integ-claude) merges every PR, one at a time, as soon as CI, the independent review and live Jev agree. Nobody else merges, and no PR is left waiting.
- Evidence before claims: tests, logs and screenshots attached to the slice with `rig proof add`.
- Secrets stay in local env files and the hosting provider; never in code, commits, tasks, tests or logs.
- If you have no owned work, wait quietly.
