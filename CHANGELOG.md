# Changelog

Notable changes to agent-stack. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The repo
has no version numbers; entries are grouped by the day they merged, newest first, with their pull requests.

## [Unreleased]

### Added
- Jev as the decision layer for routine judgments: code gathers the evidence and owns the thresholds, and anything
  short of Jev's act band goes to the lead or a person.
  - `agent-merge-evidence <pr> --decide`: the merge gate's input from exact-head facts (full shas, every required check
    by name, the independent-review status and the review report it links to, QA's bug-review-board proof, the
    blast-radius comment, target branch, deploy effect, rollback). It refuses if the PR moves while it collects. Only
    a live (not stubbed) Jev `merge` in the act band passes.
  - `agent-dispatch pick-seat`: Jev picks the seat for a dispatch (new decision `intake.seat`) from the running seats
    of the role that are idle with no open work; on review or uncertain the lead picks and records why.
  - `agent-stuck-check` (every 10 minutes): warns a rig's lead when a seat holding work looks looping, rate-limited or
    stalled (new decision `seat.stuck`). It never acts.
- `agent-project-check` warns when a Fable seat's screen asks for Fable's one-time usage-credits consent, and says how
  to fix it (`/model fable` once).

### Changed
- Model defaults for every team template and every onboarding: architects run `claude-fable-5-1`, Codex implementers
  run `gpt-6-astra`. Reviewers, QA and the Claude UI implementers are unchanged. Rationale and Jev request ids:
  [docs/REFERENCE.md](docs/REFERENCE.md#models-and-decisions).
- The lead's and the merge owner's role texts and the CULTURE template use the new Jev helpers.

### Fixed
- `agent-merge-evidence` no longer says CI is MISSING when the base branch has no required checks (no ruleset or
  protection). It reports the check runs and statuses observed on the exact head, and names any failing or
  unfinished one. A check run and a status sharing a name are both shown, and the helper's own review and gate are
  never counted as CI. Any protected base, including one protected only by rules like signatures or required
  reviews, is unchanged.
- `agent-merge-evidence` always states the review verdict with its source and head binding, so it reaches Jev even
  when the report the status links to can't be read. The sources, in order: the status's own state and description
  on the exact head; GitHub reviews submitted on the exact head by a login mapped (`identities`) to another family;
  review comments declaring the head. A review of an older commit never counts. Disagreeing sources are a CONFLICT,
  and no verifiable source says why.
- `agent-merge-evidence` reports the merge state as "pending this gate" when the only unmet required context is
  `jev-merge` itself (GitHub's BLOCKED was circular and drew no-concern holds); any other missing or failing required
  context, a review requirement or a conflict keeps BLOCKED, with the reasons. Requirements it can't verify
  (deployments, signatures, merge queue, conversations, linear history, locks, restrictions) keep BLOCKED and are
  named. A same-name success never masks a failing required check, and an app-bound context needs that app's check
  run. A `jev-merge` that already failed is reported as failed.
- `agent-merge-evidence` can read the independent review, QA's verdict and the gate's own record from PR comments,
  for repositories that record them there, configured per repository (`.agent-stack/merge-evidence.json`). A comment
  counts only with its configured heading and exactly one declared candidate equal to the full head sha. Its verdict
  comes from its own declaration lines, never from fenced or quoted examples, and conflicting declarations fail
  closed. The review must come from a seat of another family than the author's, and its body and stated limits go
  into the evidence. Commit statuses are read across all pages. Before this, such repositories got a false MISSING review and a forced hold.
- `agent-merge-evidence` says `N/A: <reason>` instead of MISSING when the bug-review-board proof or the blast radius
  doesn't apply, from verified facts only: the PR's creation time against the rig's cutoff (`AGENT_BRB_REQUIRED_SINCE`
  or the CULTURE transition bullet), and the diff (docs only; acceptance tests; `features.json` flag flips). Jev read
  MISSING as a gap and held no-defect PRs.
- The CULTURE template's merge-gate line keeps the integrator's below-bar path: a Jev merge below the act bar, with
  every deterministic gate green, merges after a one-line exact-head `confirm <sha>` from the other-family reviewer.
  `agent-merge-evidence --decide` reports a live Jev merge below the act bar (review or uncertain band) as NEEDS
  CONFIRM (exit 3), not HOLD, when every gate it checks is green (required checks, independent-review, QA's qa PASS
  for this head, not a draft, mergeable, up to date).

## 2026-09-30

### Added
- A small (10-seat) team template, and seats found by role from the team spec (merge owner, QA judges, lead) ([#22]).
- Onboarding of existing repos with any trunk: the repo is adopted as it is, with a local `main` mirror for OpenRig
  ([#23]).
- A single inventory of every skill and its source, `agent-skills-check`, and the Vercel plugin in `install.sh`
  ([#31]).
- Rebuild handovers: `agent-seat-recap` publishes a seat's packet where a rebuild reads it; `agent-seat-handover` waits
  for the real result instead of the CLI's 5-second timeout ([#32]).
- Six workflow skills in every rig by default: bug review board, verification guide, blast radius, review lenses,
  unslop and technical writing, adapted with credit from rayfernando-skills (Apache-2.0) and pstack (MIT) ([#33]).
- One-conversation onboarding: the `project-onboarding` skill for the operator and `agent-project-onboard` for the
  mechanical steps ([#34]).
- The owner's human address as a per-machine setting (`agent-owner-address`, `config/owner.env`) ([#36]).

### Changed
- Research, then plan, then implement is the default for every slice ([#28]).
- The README is a tested front door (its runnable examples run in a throwaway HOME), with example conversations with
  the operator; the detail moved to `docs/REFERENCE.md` ([#29], [#33], [#34]).
- `install.sh` never downgrades OpenRig through a stale pin; version defaults are tracked ([#25]).

### Fixed
- Claude seats are pre-trusted, so none stops on "trust this folder?" at first launch; the guidance refresh keeps
  block names ([#24]).
- OpenRig patch 140: a row that was posted and then closed by a direct human reply keeps its posted delivery outcome;
  an alert that was never posted still shows "never posted" ([#27]).
- The credential guard never loops behind a mise shim where mise doesn't activate the tool ([#35]).
- `agent-project-new` prints no "Next:" hint of its own under the onboarding helper ([#36]; tested end to end in
  [#37]).
- `install.sh` reports a valid `config/owner.env` correctly next to an environment override ([#37]).

### Security
- Browser test logins are typed by name through the Playwright MCP's `--secrets`, so values never reach a seat's
  transcript ([#26]).
- A credential guard in front of `neon` and `vercel` refuses to print connection strings or tokens into a seat's
  output ([#30]).
- The public repo names no client projects or people; a test keeps it that way ([#34]).

[#22]: https://github.com/korallis/agent-stack/pull/22
[#23]: https://github.com/korallis/agent-stack/pull/23
[#24]: https://github.com/korallis/agent-stack/pull/24
[#25]: https://github.com/korallis/agent-stack/pull/25
[#26]: https://github.com/korallis/agent-stack/pull/26
[#27]: https://github.com/korallis/agent-stack/pull/27
[#28]: https://github.com/korallis/agent-stack/pull/28
[#29]: https://github.com/korallis/agent-stack/pull/29
[#30]: https://github.com/korallis/agent-stack/pull/30
[#31]: https://github.com/korallis/agent-stack/pull/31
[#32]: https://github.com/korallis/agent-stack/pull/32
[#33]: https://github.com/korallis/agent-stack/pull/33
[#34]: https://github.com/korallis/agent-stack/pull/34
[#35]: https://github.com/korallis/agent-stack/pull/35
[#36]: https://github.com/korallis/agent-stack/pull/36
[#37]: https://github.com/korallis/agent-stack/pull/37
