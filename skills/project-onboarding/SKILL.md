---
name: project-onboarding
description: The kernel operator's end-to-end playbook for "onboard <repo or project>". It takes a new or existing repo from the owner's request to a running team with a reviewed plan (missions, slices, waves, witness slices, docs/VERIFY.md) and a clean agent-project-check. Use when the owner asks to onboard, add, set up or start a project, or hands over a repo, a plan, docs or a list of issues to work on.
---

# Onboard a project

The owner says something like "Onboard github.com/acme/shop, it's an existing Next.js app, small team, here are the
issues to fix". You take it from there to a running team working on a reviewed plan. You ask only what you cannot find
out yourself, and you never do the things listed at the end without the owner.

## 1. Intake: ask only what you can't derive

Read the repo first: README, AGENTS.md or CLAUDE.md, `package.json` or similar, CI workflows, `vercel.json`, the
default branch, branch rules (`gh api repos/<o>/<r>/rulesets`), open issues. Then ask the owner, in ONE message
(`--human-intent decision`), only for what is still missing:

- **Repo:** a URL to adopt, or a new repo (GitHub owner and name).
- **Team size**, with your recommendation:
  - `core` (4 seats): a small fix or a tool with no UI;
  - `small` (10): a handful of issues or one feature area in an existing app;
  - `build` (14): a multi-feature plan on one app;
  - `full-stack` (27): a large new product built in parallel.

  More seats cost more subscription time; say so.
- **Hosting and data:** where it deploys (for example Vercel) and what it stores data in (for example Neon, Blob). Say
  whether merges deploy to production automatically.
- **The work:** a plan in their words, existing docs, or a list of GitHub issues.
- **Standing decisions:** who approves the plan (the owner, or you on their behalf), who approves merges (the default
  is independent review plus live Jev; no owner approval per PR), what needs their explicit go (production data,
  launches), and anything they never want.
- **Existing repo with no branch protection:** may `agent-project-new` add its protection and labels? Only an explicit
  yes sets `GITHUB_SETUP=yes`.

Record the answers in `~/.openrig/state/<project>-stage/` (plan, owner decisions, CULTURE specifics, answers file).

## 2. Steps, in order

1. **Clone or adopt.** An existing repo goes to `~/Projects/<Name>`; `agent-project-new` adopts it as it is (trunk,
   rules, files).
2. **Keep agents on development data** ([docs/PROJECT-ENV.md](../../docs/PROJECT-ENV.md)):
   - a development database branch with its own password (reset it on the child branch);
   - a development file store;
   - `.env.local` pulled for Development only;
   - production and preview env files kept outside the repo, owner-only.

   Verify with the password-hash check in PROJECT-ENV. Creating branches and stores in the provider is the owner's or
   yours with their OK; never touch production.
3. **Create the team.** Write the answers file (`rig/template/onboarding/answers.example.env`) and run
   `agent-project-onboard <answers>`: a dry run that shows every step. Read it. Then run it with `--apply`. It clones,
   creates the repo, workspace and worktrees without starting seats, pulls the development env, stages the files
   below, and then starts the team, so seats launch with their env and rules in place.
4. **The owner's plan** goes to `~/Projects/<Name>-work/docs/PLAN.md`: their goal, users, what people must be able to
   do, rules and limits, out of scope, stack and hosting, and what done looks like. Write it from their words and
   docs; mark anything you inferred. For an issues-based project, one mission per issue, and the issue workflow:
   research, plan, implement, verify; never close an issue; when done, comment on it (what was wrong, what changed with
   the PR link, where to see it, exact re-test steps), reassign it to its creator and ask them to re-test.
5. **CULTURE.** In `<Name>-work/rig/CULTURE.md`, the owner's own decisions go under "Owner decisions" (dated, one
   bullet each, ending with its source: `(owner, via operator relay of <ref>)`); operator and lead rules go under
   "Operator and lead rules"; and the project's facts under "## <Name> specifics": trunk, package manager, required checks and merge path,
   databases and env (what seats use and never touch), deploys (what a merge ships, where the witness runs).
   `agent-project-onboard` appends both from the staged files; then run `agent-refresh-guidance <Name> --apply`.
6. **Brief the lead.** Review `<Name>-work/docs/lead-brief.md` (rendered from
   `rig/template/onboarding/lead-brief.md`), then send it:
   `rig send <lead seat> "$(cat ~/Projects/<Name>-work/docs/lead-brief.md)"`.
7. **Wait for plan-ready** from the lead (a queue row to you). The brief tells the lead to dispatch no builder until
   you send "plan approved".
8. **Review the plan before builders start:**
   - every slice SPEC has research findings, a plan, a Territory and a proof contract;
   - waves in each mission.yaml, load-bearing work (schema, auth, payments, data cleanup) in its own wave;
   - a W witness slice at the end of each user-facing wave;
   - `docs/VERIFY.md` written by the architect (`verification-guide`);
   - `agent-project-check <Name>`: no FAIL.

   Send gaps back to the lead, and review again.
9. **Approve the plan.** Unless the owner delegated plan approval to you (CULTURE records which), send them the plan
   summary as ONE decision request (`--human-intent decision`): the team, missions, waves, the first wave's slices,
   and what will need their decision later. With their OK (or yours when delegated), tell the lead:
   `rig send <lead seat> "plan approved"`. Then report to the owner (`--human-intent update`) how to follow along
   (`rig ps`, the daily summary).

## 3. Never without the owner

- Touch production data, production env files or production stores. Rehearse on a fresh branch and bring a report.
- Change branch protection, rulesets or merge settings on an existing repo.
- Add seats beyond the agreed team size, or start a second team.
- Close issues, publish releases, or change billing or domains.

When unsure, ask one precise question with your recommendation instead of guessing.

---
Built from a real onboarding (2026-09-30): an existing repo on `master`, a list of GitHub issues, Vercel and
Neon, deploy on merge.
