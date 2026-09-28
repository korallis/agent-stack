# Shared OpenRig team template

One set of roles for every repository. Each repo's rig is a small folder (`<workspace>/rig/`) containing a copy of a
spec, a culture file and the merge-sweep watchdog; the roles are referenced here by `path:` so improving a role here
improves every repo's rig the next time it launches.

| File | What it is |
|---|---|
| `agents/<role>/` | lead, deputy, architect, test-author, implementer, qa, reviewer, integrator (merge owner), recovery |
| `CULTURE.md` | shared team rules (copy into each rig folder and append that repo's specifics) |
| `core.yaml` | 4 seats: Claude lead, Codex implementer, Codex reviewer, Claude merge owner |
| `team.yaml` | 24 seats: balanced 12 Claude + 12 Codex |
| `build.yaml` | **Daily build team, 14 seats.** Models pinned per the routing table in `CULTURE.md`: Opus 5.5 lead/architect/UI/reviewer/merge owner, GPT-6 Sol implementers/QA/reviewer, GPT-6 Astra escalation seat, Kimi K3 (1M) third-family reviewer, test authors of both families. Max 4 busy implementers |
| `fallback-codex.yaml` | Same roles with no Claude accounts: Codex builds and merges, Kimi writes the locked tests and reviews |
| `daily-summary.watchdog.yaml` | Wakes the lead once a day to write `docs/summary/<date>.md` and notify the owner |
| `merge-sweep.watchdog.yaml` | wakes the merge owner every 15 minutes |

Merge rule everywhere: the merge owner (`integ-claude`) merges each PR as soon as required CI is green, an independent
non-author review is done with findings actioned, and live Jev says merge (repo procedure if it has one, else the shared
`review.merge_gate` decision). Nobody else merges.

## New repository, step by step (plain OpenRig + git)

```bash
R=~/Projects/<Repo>; W=~/Projects/<Repo>-work; WT=~/Projects/<Repo>.worktrees; RIG=<short-name>

# 1. workspace
rig config init-workspace --root $W
rig config set workspace.root $W; rig config set workspace.slices_root $W/missions
rig config set workspace.catalog_path $W/workspace.yaml; rig config set files.allowlist workspace:$W
systemctl --user restart openrig.service; rig workspace doctor
#    edit $W/SPEC.md, workspace.yaml (project id), add conventions.md to project.yaml install.context

# 2. worktrees (one per seat; implementers get a branch) + commit identity if the repo requires one
cd $R
git worktree add --detach $WT/coord-lead-claude main
git worktree add $WT/impl-codex-1 -b agent/impl-codex-1 main
git worktree add --detach $WT/review-codex main
git worktree add --detach $WT/integ-claude main
#    then install dependencies in each worktree (never symlink node_modules)
#    and add OpenRig's per-seat files to .git/info/exclude: /.codex/ /.claude/settings.local.json /.claude/skills/ /.openrig/ /.mcp.json /CLAUDE.local.md

# 3. rig folder
mkdir -p $W/rig; cd $W/rig
cp ~/Projects/agent-stack/rig/template/{core.yaml,CULTURE.md,merge-sweep.watchdog.yaml} .
sed -i "s#@RIG@#$RIG#g; s#@REPO@#$R#g; s#@WT@#$WT#g" core.yaml merge-sweep.watchdog.yaml
#    append a "<Repo> specifics" section to CULTURE.md (status names, Jev procedure, commit identity)
rig spec validate core.yaml && rig up core.yaml

# 4. keep PRs moving
rig watchdog register --policy periodic-reminder --spec $W/rig/merge-sweep.watchdog.yaml \
  --target-session integ-claude@$RIG --interval-seconds 900 --registered-by lee
```

Workspace config is machine-wide: one project workspace is active at a time (`rig config get workspace.root`).


## Plan in, user-tested features out (build.yaml)
1. You write `docs/PLAN.md` in a repo made from `~/Projects/agent-stack/starter-kit` and send the lead "Build docs/PLAN.md".
2. The architect turns it into `features.json` with acceptance criteria written as things a person does and sees. You get one desktop notification to approve it.
3. For each feature, the test author of the *other* model family writes locked Playwright journeys (a person using the app, desktop and phone). CI rejects any implementation PR that touches them.
4. The lead routes the feature to an implementer with Jev; the implementer builds with Superpowers until the journeys pass.
5. The QA seat uses the running app by hand in a real browser and attaches screenshots; a reviewer of the other family reviews with the plan and criteria; risky changes get a Kimi review and your OK.
6. The merge owner also runs a held-out journey suite the implementers never see, then merges through live Jev. Two red CI runs escalate the feature to the Astra seat.
7. Daily summary notification; final report when every feature `passes`.
