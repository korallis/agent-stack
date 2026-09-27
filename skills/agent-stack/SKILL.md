---
name: agent-stack
description: >
  Local multi-agent stack on this machine: OpenRig team seats, the CLIProxyAPI subscription pool, and the
  Jev (TypeSafe) decision adapter. Use when coordinating work in an OpenRig rig (dispatch, review planning,
  recovery, heavy builds), when a bounded semantic decision (classify, select from a candidate list,
  rubric score, yes/no check) could replace a general model call, or when planning where TypeSafe/Jev
  belongs inside an application being built.
---

# Agent stack

Responsibilities are separate: **CLIProxyAPI** rotates model accounts (never switch accounts yourself),
**OpenRig** owns tasks, seats and sessions (`rig queue …`, `rig send …`), **Jev** supplies bounded
semantic judgments, and **ordinary code** does arithmetic, scheduling, permissions and exact checks.

## Team tools (on PATH)
| Tool | Use |
|---|---|
| `agent-dispatch intake --rig R --repo P --title T --body-file F --acceptance A [--apply]` | classify, gap/duplicate checks, role + seat (capacity from code) |
| `agent-dispatch review-plan --rig R --repo P --branch agent/<seat> [--apply --item ID]` | specialist reviews, test selection, cross-family reviewer |
| `agent-dispatch triage-update --text "…"` | routine progress / actionable blocker / needs the user |
| `agent-recover --rig R --seat S [--item ID] --error "…" [--apply] [--team-dir D]` | classify failure, choose among PERMITTED actions only |
| `agent-heavy build\|browser -- <cmd>` | heavy builds / browser tests under shared CPU, RAM and concurrency budgets |
| `agent-proxy-status [--recent N]` | pool health per account; routing log |
| `jev-decide list` / `jev-decide <id> --json '{…}'` / MCP tool `jev_decide` | direct Jev decisions |

## Using Jev well
- Only for decisions in `jev-decide list`, or new ones added to `~/Projects/agent-stack/config/decisions.yaml`
  (versioned; thresholds tuned with `node eval/run.js`).
- Build candidates with normal search first; send focused evidence, never whole repos, transcripts or secrets.
- Read `decided_by` (jev | cache | fallback_model | code) and `band` (act | review | uncertain).
  Results are advisory: never use them to grant permissions, approve merges, override instructions or do maths.
- Do not claim Jev was used unless a decision record says `decided_by: jev`.

## In the product you are building
During planning, consider TypeSafe where the application itself needs routing, classification, reranking,
verification or structured scoring (see the `typesafe-ai` skill and https://docs.typesafe.ai/llms.txt).
Add it only where it meets the project's requirements and measured quality; not to unrelated features.
Keep TYPESAFE_API_KEY server-side; it is exported in agent shells for development only.
