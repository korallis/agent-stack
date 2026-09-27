# Validation record — 2026-09-27

Disposable repo: `~/Projects/rig-pilot`. Evidence came from process tables, proxy usage records, Codex/OpenRig logs, git and test runs.

| Requirement | Result | Evidence |
|---|---|---|
| Six distinct identities | ✅ | 2 Claude (org hashes bd1faed5, ae273fe9), 4 ChatGPT **pro** (f479ae30, dbbe0512, 600d6e13, 143d24e5) |
| Inference through every account | ✅ | streamed PONG per account; proxy usage record per `auth_index`; model returned == model requested |
| No paid fallback | ✅ | no `api-keys` upstreams; Claude overage `rejected`; Codex `has_credits=False` on all 4 |
| Claude Code via proxy: generate, stream, tools, follow-up | ✅ | `apiKeySource=apiKeyHelper`, Write+Bash tool calls, `--resume` recalled turn 1 |
| Codex via proxy: generate, stream, tools, follow-up | ✅ | shell tool calls, `exec resume` recalled turn 1 |
| Session affinity | ✅ | Codex seat's conversation stayed on one account, cache hits grew 15.6k→49.4k tokens |
| Account exclusion / failover (same model) | ✅ | disabled claude-a → 3/3 on claude-b; 3 Codex disabled → codex-d served |
| All accounts unavailable reported clearly | ✅ (via recover) | proxy: `400 unknown provider…`; `agent-recover` → `POOL EXHAUSTED: codex has 0/4…`, escalate only |
| Proxy restart during live stream | ✅ | Codex: "stream disconnected… retrying 1/5 in 193ms", same task completed; no duplicate commits |
| No direct provider routing from seats | ✅ | after disabling background traffic: 0 external connections from pilot seats; kernel seats only to Exa/Context7 MCP |
| Implement → test → cross-family review → integrate (twice) | ✅ | 72b05c3 and f801aad: Codex implemented on `agent/impl-codex-1`, Claude lead reviewed, ff-merged, 10/10 tests |
| Task ownership + messaging | ✅ | queue items dispatched, claimed, handed off, closed with reasons; transitions logged |
| Session resume (rig down --snapshot / up) | ✅ | `fully_restored`; Claude `--resume <same id>`, Codex `resume <thread>`; seat recalled prior commit |
| 24-seat team | ✅ | 24/24 `running`; all YOLO; 24 distinct worktrees; Claude seats on pool env; Codex seats via shim; Jev MCP in all |
| Jev live calls (routing, context, triage) | ✅ | intake/paths/requirements/classify/specialist/change_class/select_tests from seats; batched 3 decisions in 1 request |
| Jev uncertain / timeout / malformed / unavailable | ✅ | simulated + real: refused endpoint → code fallback, breaker opened after 5 (6th call 18 ms), hanging endpoint → aborted at 20 s budget → fallback model |
| Recovery safety (budgets, ownership, duplicates) | ✅ | 16/16 unit tests |

## Jev evaluation (46 labelled cases: clear, ambiguous, adversarial)

| Decision | Jev | Jev when `act` | System (with fallback) | Keyword baseline | p50 |
|---|---|---|---|---|---|
| recovery.classify_error (v3) | 100% | 100% | 100% | 94% | ~290 ms |
| comms.triage_update (v3) | 88% | 100% | 100% | 88% | ~295 ms |
| intake.classify | 100% | 100% | 100% | 100% | ~255 ms |
| review.triage_finding | 83% | 80% | 83% | — | ~295 ms |
| review.completion_claim | 75% | 100% | 100% | — | ~250 ms |
| context.rerank | 100% | 100% | 100% | — | ~300 ms |

Prompt-injection cases: Jev resisted 4/5 outright; the 5th ended `uncertain` and the system escalated correctly.
Caveat: v3 wording changes were tuned on these same cases — add held-out cases before relying on fine distinctions.
Re-run: `cd ~/Projects/agent-stack && node eval/run.js` (report in `eval/report.json`).
