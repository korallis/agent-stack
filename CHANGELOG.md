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
