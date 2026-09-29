# Project starter kit

Everything a new repository needs so the OpenRig build team can take a plan to merged, user-tested features.
The core rule: **a feature is done only when a person could use it.** Proof is browser journeys written before the
feature exists and locked against the implementers, plus a hands-on QA pass.

| File | What it does |
|---|---|
| `AGENTS.md` | Binding rules for every seat (replace `@PROJECT@`, `@HELDOUT@`, `@COMMIT_IDENTITY@`) |
| `docs/PLAN.md` | Your plan. The only thing you write |
| `features.json` + `docs/features.schema.json` | Feature list with user-visible acceptance criteria and `passes` flags |
| `PROGRESS.md`, `docs/summary/` | Merge log and daily summaries |
| `tests/acceptance/` | Locked user journeys (see its README) |
| `playwright.config.ts` | Runs every journey on desktop and phone, with screenshots, and video on failure |
| `scripts/guards/check-human-perspective.sh` | Fails journeys that test the inside of the app instead of using it |
| `scripts/guards/check-protected-paths.sh` | Fails implementation PRs that touch the locked journeys or the guards |
| `.github/workflows/ci.yml` | `guards`, `app` and `acceptance` checks |
| `.github/pull_request_template.md` | Asks for journey results and QA evidence |
| `scripts/setup-github.sh` | Branch protection and the `owner-approved` label |

## Start a project

Use `agent-project-new --name <P> --rig <short> --github <user>` (then `agent-project-check <P>`): it runs every step below,
idempotently. The manual steps are kept for reference.

```bash
P=MyProject; GH=<your-github-user>; ID="Your Name <you@example.com>"; R=~/Projects/$P; W=~/Projects/$P-work; WT=~/Projects/$P.worktrees; H=~/Projects/$P-heldout; RIG=myproj; LEAD=coord-lead-claude; MERGE=integ-codex   # full-stack seat names

# 1. repo from the kit (keep your own app scaffold; the kit only adds files)
mkdir -p $R && cp -rn ~/Projects/agent-stack/starter-kit/. $R/ && cd $R && rm README.md
sed -i "s#@PROJECT@#$P#g; s#@HELDOUT@#$H#g; s#@COMMIT_IDENTITY@#$ID#g" AGENTS.md docs/PLAN.md
git init -b main && git add -A && git commit -m "chore: starter kit"
#    add package.json scripts: start:test (serves on :3000 with test data), and optionally lint/typecheck/test
npm i -D @playwright/test

# 2. held-out journeys live outside the repo, so implementers never see them
mkdir -p $H

# 3. GitHub (private repo), then protection
gh repo create $GH/$P --private --source . --push
scripts/setup-github.sh $GH/$P

# 4. rig: the full-stack team (27 seats; use build.yaml for a 14-seat team)
mkdir -p $W/rig && cd $W/rig
cp ~/Projects/agent-stack/rig/template/{full-stack.yaml,CULTURE.md,merge-sweep.watchdog.yaml,daily-summary.watchdog.yaml} .
sed -i "s#@RIG@#$RIG#g; s#@REPO@#$R#g; s#@WT@#$WT#g; s#@AGENT_STACK@#$HOME/Projects/agent-stack#g; s#@LEAD_SEAT@#$LEAD#g; s#@MERGE_SEAT@#$MERGE#g" full-stack.yaml merge-sweep.watchdog.yaml daily-summary.watchdog.yaml
#    own workspace (other projects keep running) + one worktree per seat:
rig config init-workspace --root $W && sed -i "s/  - id: default/  - id: $RIG/" $W/workspace.yaml
cat ~/Projects/agent-stack/rig/template/project-sdlc.yaml >> $W/project.yaml   # SDLC + wave model + git defaults
for k in files.allowlist progress.scan_roots; do c=$(rig config get $k); rig config set $k "${c:+$c,}$RIG:$W"; done
printf '  - id: %s\n    root: %s\n' "$RIG" "$W" >> ~/Projects/openrig-workspace/workspace.yaml && systemctl --user restart openrig.service
#    worktrees: see ~/Projects/agent-stack/rig/template/README.md (keep the $P.worktrees / $P-work names:
#    seats find their workspace from them)
rig spec validate full-stack.yaml && rig up full-stack.yaml
rig watchdog register --policy periodic-reminder --spec $W/rig/merge-sweep.watchdog.yaml --target-session $MERGE@$RIG --interval-seconds 900 --registered-by $USER
rig watchdog register --policy periodic-reminder --spec $W/rig/daily-summary.watchdog.yaml --target-session $LEAD@$RIG --interval-seconds 86400 --registered-by $USER

# 5. write docs/PLAN.md, commit it, then:
rig send $LEAD@$RIG "Build docs/PLAN.md"

# 6. once the lead has the feature list approved, check the wiring (see the agent-stack skill checklist):
#    every mission has a wave-map row, slices have depends_on + Territory, queue rows carry project/mission/slice
for m in $W/missions/*/; do rig scope audit --mission $(basename $m) --workspace $W; done
rig view show execution --mission <m> --json | jq '.rows[0].sources.wave_map, [.rows[0].q1_lanes[].fragile_join]'
```

From then on you get a desktop notification when the feature list is ready for your approval, when a risky PR
needs your OK, when something is blocked, and once a day with the summary.
