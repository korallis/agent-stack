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
| `full-stack.yaml` | **Default: the large, fast team, 27 seats.** Pinned per the Jev routing table: 8 GPT-6 Sol implementers + 2 Opus UI implementers + Astra escalation, 3 Sol QA seats, 2 Opus + 2 Sol + 1 Kimi reviewers, Opus lead/architect/merge owner, Sol deputy and recovery, test authors of both families. About 9 implementers busy at once |
| `small.yaml` | **Small team, 10 seats.** `build.yaml` without impl.codex-2/-3, impl.astra and tests.codex: Opus lead/architect/UI implementer/test author/reviewer/merge owner, one GPT-6 Sol implementer, Sol QA and reviewer, Kimi reviewer. Same culture, gates and watchdogs |
| `build.yaml` | **Standard team, 14 seats.** Models pinned per the routing table in `CULTURE.md`: Opus 5.5 lead/architect/UI/reviewer/merge owner, GPT-6 Sol implementers/QA/reviewer, GPT-6 Astra escalation seat, Kimi K3 (1M) third-family reviewer, test authors of both families. Max 4 busy implementers |
| `fallback-codex.yaml` | Same roles with no Claude accounts: Codex builds and merges, Kimi writes the locked tests and reviews |
| `daily-summary.watchdog.yaml` | Wakes the lead once a day to write `docs/summary/<date>.md` and notify the owner |
| `merge-sweep.watchdog.yaml` | wakes the merge owner every 15 minutes |

Merge rule everywhere: the merge owner (the `integ-*` seat) merges each PR as soon as required CI is green, an independent
non-author review is done with findings actioned, and live Jev says merge (repo procedure if it has one, else the shared
`review.merge_gate` decision). Nobody else merges.

## New repository, step by step (plain OpenRig + git)

```bash
R=~/Projects/<Repo>; W=~/Projects/<Repo>-work; WT=~/Projects/<Repo>.worktrees; RIG=<short-name>

# 1. workspace (its own; other projects keep running untouched)
rig config init-workspace --root $W                 # does not change the global workspace.root
sed -i "s/  - id: default/  - id: $RIG/" $W/workspace.yaml
for k in files.allowlist progress.scan_roots; do c=$(rig config get $k); rig config set $k "${c:+$c,}$RIG:$W"; done
printf '  - id: %s\n    root: %s\n' "$RIG" "$W" >> ~/Projects/openrig-workspace/workspace.yaml   # list it in the all-projects catalog
openrig-daemon-cycle                         # restarts only the daemon to pick up the new roots; seats are untouched
#    seats find this workspace automatically: env.sh sets OPENRIG_WORK_ROOT=~/Projects/<Repo>-work for any seat
#    running in ~/Projects/<Repo>.worktrees/<seat> (so keep those two names). Only if this is your very first
#    project on a machine not set up by install.sh, create ~/Projects/openrig-workspace first (see config/openrig-workspace/)
#    edit $W/SPEC.md, add conventions.md to project.yaml install.context

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
sed -i "s#@RIG@#$RIG#g; s#@REPO@#$R#g; s#@WT@#$WT#g; s#@AGENT_STACK@#$HOME/Projects/agent-stack#g; s#@MERGE_SEAT@#integ-claude#g; s#@LEAD_SEAT@#coord-lead-claude#g" core.yaml merge-sweep.watchdog.yaml   # or build.yaml / team.yaml / fallback-codex.yaml
#    append a "<Repo> specifics" section to CULTURE.md (status names, Jev procedure, commit identity)
rig spec validate core.yaml && rig up core.yaml

# 4. keep PRs moving
rig watchdog register --policy periodic-reminder --spec $W/rig/merge-sweep.watchdog.yaml \
  --target-session integ-claude@$RIG --interval-seconds 900 --registered-by $USER
```

Run as many projects at once as your quotas allow. Each project has its own workspace (`~/Projects/<Repo>-work`), rig and worktrees; the global `workspace.root` is only the default for commands run outside any seat. Pass `--workspace <path>` (or set `OPENRIG_WORK_ROOT`) when you run `rig scope` / `rig proof` by hand for a specific project.


## Plan in, user-tested features out (full-stack.yaml or build.yaml)
1. You write `docs/PLAN.md` in a repo made from `~/Projects/agent-stack/starter-kit` and send the lead "Build docs/PLAN.md".
2. The architect turns it into `features.json` with acceptance criteria written as things a person does and sees. You get one desktop notification to approve it.
3. For each feature, the test author of the *other* model family writes locked Playwright journeys (a person using the app, desktop and phone). CI rejects any implementation PR that touches them.
4. The lead routes the feature to an implementer with Jev; the implementer builds with Superpowers until the journeys pass.
5. The QA seat uses the running app by hand in a real browser and attaches screenshots; a reviewer of the other family reviews with the plan and criteria; risky changes get a Kimi review and your OK.
6. The merge owner also runs a held-out journey suite the implementers never see, then merges through live Jev. Two red CI runs escalate the feature to the Astra seat.
7. Daily summary notification; final report when every feature `passes`.
