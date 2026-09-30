# agent-stack

**Write a plan. Get working, user-tested software back.**

agent-stack turns one Linux computer into a software team made of AI coding agents. You describe what you want in
`docs/PLAN.md`. The team splits it into features, writes browser tests first, builds, uses the result the way a person
would, reviews it with a second AI family, and merges it through a gate. You approve the feature list once, sign off
risky changes, and answer the questions only you can answer.

It is glue and configuration around existing tools: [OpenRig](https://www.npmjs.com/package/@openrig/cli) runs the
team, Claude Code and Codex CLI are the agents' workspaces, [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
pools your subscriptions, [TypeSafe Jev](https://typesafe.ai) makes the small typed decisions (who builds this, may
this merge), and Playwright gives the agents a real browser.

## Quick start

You need Linux, git, and accounts for GitHub and at least one of Claude or ChatGPT. Clone the repo and see what is
missing. The check installs and configures nothing (its small side effects are listed under "Check the machine"):

```bash
# Runs as shown (the README test runs this block in a throwaway HOME).
git clone https://github.com/korallis/agent-stack ~/Projects/agent-stack
cd ~/Projects/agent-stack && ./install.sh --check
```

Then install, and sign in to your accounts. Logins open a browser, so they can't be scripted:

```bash
# Illustrative: installs software and needs your accounts (the README test checks each command and flag exists).
./install.sh
gh auth login
agent-login claude claude-a        # once per Claude subscription (claude-b, ...)
agent-login codex codex-a          # once per ChatGPT subscription
```

Paste your TypeSafe key into `~/.config/agent-stack/secrets/typesafe.env`, then start a project (below).

## How it works

```text
you --> docs/PLAN.md --> lead --> queue --> architect, test author, implementers
                                                          |
                                                     pull request
                                                          |
                      QA (real browser) + reviewer (other AI family) + Jev merge gate
                                                          |
                                               merge --> witness (fresh agent)
```

- **Rig.** One project's team, started from a spec in `~/Projects/<Project>-work/rig/`. `rig ps` lists the running rigs.
- **Seat.** One agent with a role, its own git worktree and its own conversation. A seat's name is
  `<pod>-<member>@<rig>`, for example `coord-lead-claude@myapp`.
- **Queue.** Seats hand work to each other as queue rows. Every row has one owner (`rig queue list`).
- **Merge gate.** A pull request merges only when CI, a review by the other AI family, QA's ship verdict and a live Jev
  decision agree on the exact commit.
- **Witness.** After a wave of features merges, a fresh agent that built none of it uses them on the deployed app and
  records what it saw.

Every rig also follows six workflow skills: a feature map in `docs/VERIFY.md`, a real-user bug review before merge,
a blast-radius check on risky diffs, named review lenses, and plain writing. [docs/SKILLS.md](docs/SKILLS.md) lists
them with every other skill.

## Examples

### Create a project for a new repo

See what it would create, without creating anything:

```bash
# Runs as shown (the README test runs this block in a throwaway HOME).
agent-project-new --name Demo --rig demo --no-github --identity "Demo Bot <bot@example.invalid>" --dry-run
```

Then create it for real. It makes a private GitHub repo with the starter kit, the team's workspace and one worktree per
seat, and starts the team:

```bash
# Illustrative: creates a GitHub repo and starts a team (the README test checks each command and flag exists).
agent-project-new --name MyApp --rig myapp --github <your-github-user>
agent-project-check MyApp
rig send coord-lead-claude@myapp "Build docs/PLAN.md"
```

Write `docs/PLAN.md` in `~/Projects/MyApp` and commit it before you send that message.

### Create a project for an existing repo

Clone the repo to `~/Projects/<Name>` first. `agent-project-new` then keeps its trunk, its branch rules and its files,
and puts the starter kit in `<Name>-work/starter-kit/` for the lead to adopt in a pull request:

```bash
# Runs as shown (the README test runs this block in a throwaway HOME).
git clone https://github.com/korallis/agent-stack ~/Projects/StackDemo
agent-project-new --name StackDemo --rig stackdemo --no-github --identity "Demo Bot <bot@example.invalid>" --dry-run
```

Drop `--dry-run` (and `--no-github`) to do it. Keep seats on development data: [docs/PROJECT-ENV.md](docs/PROJECT-ENV.md).

### Dispatch a slice

The lead normally does this. A slice is one buildable piece of a mission:

```bash
# Illustrative: needs a running team (the README test checks each command and flag exists).
rig queue create --destination impl-codex-1@myapp --mission m01-accounts --slice 03-login --summary "Build 03-login" --body-file dispatch.md
rig queue list --destination impl-codex-1@myapp
```

### Run the merge gate

The merge owner (the integrator seat) does this for every pull request, on its exact head commit. Each step stops the
run when its gate fails, so the last line runs only when every gate passed:

```bash
# Illustrative: needs a real pull request (the README test also runs it with stub gh and jev-decide, failing each gate).
(
  set -euo pipefail
  pr=42 repo='<owner>/<repo>'
  head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  base=$(gh pr view "$pr" --json baseRefOid --jq .baseRefOid)
  gh pr checks "$pr" --required
  [ "$(gh api "repos/$repo/commits/$head/statuses" --jq '[.[] | select(.context == "independent-review")][0].state')" = success ]
  jev-decide review.merge_gate --json "{\"pr\":$pr,\"head\":\"$head\",\"base\":\"$base\",\"change\":\"Adds login\",\"review\":\"independent-review success; bug review board: ship YES\",\"ci\":\"required checks pass\"}" > gate.json
  jq -e '.decided_by == "jev" and .band == "act" and .result.decision == "merge"' gate.json
  gh pr merge "$pr" --squash --match-head-commit "$head"
)
```

`gh pr checks --required` fails unless every required check passed. The status line fails unless the latest
`independent-review` status on that head is `success`. The `jq -e` line fails unless live Jev (not a cache or a
fallback) answered `merge` in the act band; `jev-decide` itself exits 0 for the review band too, so its exit code is
not the gate. `--match-head-commit` refuses the merge if the branch moved after the checks.

### Relaunch a seat

Relaunch a seat only while it is idle. In its tmux pane, Codex quits with `Ctrl-U`, `/quit`, Enter; Claude with
`/exit`. Then:

```bash
# Illustrative: needs a running team (the README test checks each command and flag exists).
rig ps --json | jq -r '.[] | "\(.rigId) \(.name)"'
rig launch <rigId> impl.codex-1
rig seat status impl-codex-1@myapp
```

The seat resumes its own conversation. `docs/REFERENCE.md` says how to verify that.

### Add a secret for the browser

Test logins go in a file only you can read. Agents type them by name, so the value never appears in a transcript:

```bash
# Runs as shown (the README test runs this block in a throwaway HOME).
mkdir -p ~/.config/agent-stack/secrets
read -rsp 'Password for the MyApp test admin: ' v; echo
printf 'MYAPP_ADMIN_PASSWORD=%s\n' "$v" >> ~/.config/agent-stack/secrets/playwright.env; unset v
chmod 600 ~/.config/agent-stack/secrets/playwright.env
```

The browser tool reads the file when a seat starts: add every name a seat needs, then relaunch that seat once. Always
append; prefix names with the project.

### Check the machine

```bash
# Runs as shown (the README test runs this block in a throwaway HOME).
cd ~/Projects/agent-stack && ./install.sh --check
agent-skills-check
agent-credguard-check
```

`install.sh --check` lists what is missing and installs or configures nothing. It is not read-only: in a fresh HOME it
creates empty directories, sets the secrets directory to 0700, fills the npm cache while it checks the Playwright
browser, and Claude Code may create its own `~/.claude.json` when asked for its MCP servers. `agent-skills-check` prints one line per skill
source. `agent-credguard-check` shows which running seats have `neon` and `vercel` behind the credential guard.

## Read more

- [docs/REFERENCE.md](docs/REFERENCE.md): the full team, what gets installed, everyday commands, several projects,
  operating a fleet, upgrades, and where everything lives.
- [docs/SKILLS.md](docs/SKILLS.md): every skill, where it comes from, and who gets it.
- [docs/PROJECT-ENV.md](docs/PROJECT-ENV.md): keeping agents on development data.
- [docs/UPGRADE.md](docs/UPGRADE.md): upgrading OpenRig. [docs/incidents/](docs/incidents/): what went wrong before.
- [config/tools.md](config/tools.md): every tool and version.

## Read before you use it

- **Pooling consumer subscriptions through a proxy may break your providers' terms.** Anthropic's Claude Code terms
  prohibit it. If you pool anyway, that is your decision and your risk. `cliproxy-authwatch` alerts you if an account
  starts failing to sign in, and `fallback-codex.yaml` lets you keep working without Claude.
- **Seats run with permission checks off** so they can work unattended. Run this on a machine and accounts you are
  comfortable letting agents use, and never give seats production or cloud-admin credentials.
- **Quality comes from verification, not from the models.** The locked tests encode what "done" means, so read the
  feature list carefully before you approve it.
