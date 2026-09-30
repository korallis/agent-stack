# Skills: every one in use, and where it comes from

Only the skills marked **ours** live in this repo. Everything else is installed from its own source, so it stays current
and its licence stays with it; none of it is copied into this repo. `agent-skills-check` (run by `install.sh`, also
with `--check`) prints one line per source and WARNs on anything missing.

| Skill(s) | Source | Who gets it | How install.sh provides it | Ours |
|---|---|---|---|---|
| `agent-stack`, `openrig-project-setup` | `skills/` in this repo | Claude and Codex: every session and seat | links every `skills/*` dir into `~/.claude/skills` and `~/.agents/skills` | **ours** |
| `project-onboarding` (for the kernel operator: "onboard <repo or project>") | `skills/` in this repo | the kernel operator (install.sh adds a pointer to its instruction file) | same links | **ours** |
| Workflow skills: `bug-review-board`, `verification-guide`, `blast-radius`, `review-lenses`, `unslop`, `technical-writing` | `skills/` in this repo, adapted from rayfernando-skills (Apache-2.0) and pstack (MIT); credit and licence in each skill's folder | every seat; the rig CULTURE "Workflow skills" section and the role texts say who uses which, and when | same links | **ours** (adapted) |
| OpenRig core: all of the installed `openrig-core` plugin's skills (19 in 0.6.1: `queue-handoff`, `mission-slice-sop`, `seat-continuity-and-handover`, …) | the installed OpenRig package | Claude and Codex: every session and seat | links into both skill dirs, from the installed package | no |
| OpenRig role skills: `orchestration-team`, `development-team`, `review-team`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `dogfood`, `requirements-writer`, `ui-mockup`, `plan-review` | the installed OpenRig's shared agent (`daemon/specs/agents/shared`) | seats, by role: `uses.skills` in `rig/template/agents/*/agent.yaml` | `rig/template/openrig-shared` links to it (`openrig-upgrade` re-points the link on each machine); the rig specs project the skills into seats | no |
| Superpowers (`brainstorming`, `systematic-debugging`, …) | plugin `superpowers@claude-plugins-official`; Codex: `superpowers@openai-api-curated` | Claude; Codex | `claude plugin install`; `codex plugin add` | no |
| `typesafe-ai` | plugin `typesafe@typesafe-ai` (marketplace `typesafe-ai/skills`) | Claude (plugin); Codex (a copy in `~/.agents/skills`) | `claude plugin install`; the copy is refreshed from the plugin when it changes | no |
| Vercel (deployments, env, AI SDK, …) | plugin `vercel@claude-plugins-official` | Claude | `claude plugin install` | no |
| `neon`, `neon-postgres`, `neon-postgres-branches`, `neon-postgres-egress-optimizer` | the Neon CLI | Claude and Codex | `neon skills --global` | no |
| Claude.ai account-synced skills (`pdf`, `docx`, `pptx`, `xlsx`, `brand-guidelines`, `morning`, `import-memory`, …) | the Claude.ai account (`~/.claude/skills/synced/`) | Claude sessions signed in to that account | nothing: they come with the Claude login | no |
| `omarchy`, `diagnose-crash` | the host OS (Omarchy, `/usr/share/omarchy`) | Claude and Codex on Omarchy machines | nothing: host-specific | no |
