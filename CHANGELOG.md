# Changelog

Notable changes to agent-stack. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The repo
has no version numbers; entries are grouped by the day they merged, newest first, with their pull requests.

## [Unreleased]

### Added
- GitHub Actions CI (`.github/workflows/test.yml`, check `test`): the test suite on every pull request and on main,
  so the merge gate reads a real exact-head check. Tests that need the owner's machine (OpenRig, rig, codex,
  install.sh's prerequisites) skip with their reason. `agent-project-check` reports a missing tool instead of
  crashing.
- Credential read guard: a PreToolUse hook for Claude Code (Bash, Read, Grep) and Codex (its shell tool) refuses a
  command or read that would print a credential file (`.env*`, `*runtime-url*`, `*.pem`, `prod.env`, the secrets
  directory, plus local globs) into a seat's transcript, and says how to use the values by name. Installed
  idempotently by `install.sh` (the Codex hook with its trust hash); `agent-never-prompt-check` reports it. After two
  printed credential files on 2026-09-30.
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
- CULTURE "Owner decisions" holds only the owner's own decisions, each ending with its source (`(owner, Slack
  HH:MMZ)` or `(owner, via operator relay of <ref>)`). Operator and lead rules, and a lead's interpretations, go in
  a new "Operator and lead rules" section with their link. The lead role never records an interpretation as the
  owner's, and asks through the operator when an answer is ambiguous. `agent-project-check` WARNs on an unsourced
  Owner decisions bullet and on one resting on `docs/decisions/*`. `agent-project-onboard` adds the source to the
  decisions it stages. The template and the integrator role now say that a Jev HOLD in any band blocks the merge
  unless the owner waives it; the confirm path is only for a Jev MERGE below the act bar. After a lead's
  interpretation, filed as an owner decision, led to merges over Jev HOLDs.
- Model defaults for every team template and every onboarding: architects run `claude-fable-5-1`, Codex implementers
  run `gpt-6-astra`. Reviewers, QA and the Claude UI implementers are unchanged. Rationale and Jev request ids:
  [docs/REFERENCE.md](docs/REFERENCE.md#models-and-decisions).
- The lead's and the merge owner's role texts and the CULTURE template use the new Jev helpers.

### Fixed
- `agent-merge-evidence` finds the blast radius in any form: `### Blast radius`, a bold lead-in, or a "Blast radius:"
  paragraph. It prefers the selected review's own section, then the newest note naming this head. It used to take an
  older review's `## Blast radius` that didn't name the head. The excerpt has its own budget, so a paragraph deep in a
  long review isn't cut off.
- The credential read guard resolves paths the way the shell will run the command. It no longer refuses
  `grep x bin/*`: globs follow bash's dotfile rule, while dotglob, `.*` and `**` are still refused. It follows `cd`,
  existing symlinks, and copies or links the command makes of a credential file. It decodes `$'…'` escapes, `{a,b}`
  braces and the command's own variables, closing bypasses such as `cd <secrets dir> && cat x.env` and
  `ln -s .env n && cat n`.
- `agent-merge-evidence` no longer makes the merge gate hold on project-rig PRs. The operator's live A/B test showed
  what flipped Jev:
  - The limits line no longer says "merge state: pending this gate …" when the gate's own `jev-merge` is the only
    unmet requirement; the gate read that as a missing gate. It now says nothing about the merge state.
  - The merge owner's own gate-result comments ("live Jev merge gate HOLD") no longer return as UNVERIFIED review
    text on the next run.
  - A status link to a GitHub review on the same PR is read, with the commit it was submitted on, instead of being
    reported as "outside this PR, so not read".
  - A QA seat's exact-head `Verdict: SHIP` comment carries the QA verdict when a branch refresh left only
    `brb-<old head>.md`.
  - `change` defaults to the PR title plus the body's first section.
- `agent-merge-evidence` says `N/A` for the bug-review-board QA verdict when every changed path is CI
  configuration (`.github/workflows/**` and the like) or docs, verified from the diff. A workflow-only change (a job
  timeout) no longer needs a slice and a QA verdict. The blast radius still applies, since a CI change can break
  builds.
- `agent-merge-evidence` prints `{"input": …, "history": …}`, so Jev's input and the gate's own earlier results can't
  be mistaken for one object. The flat printout let an integrator copy the gate's own HOLD into a hand-built Jev
  input. `--extra-evidence <file>` adds caller-supplied evidence to `input.review`, labelled as unverified and
  redacted, so nobody hand-edits the JSON.
- `agent-merge-evidence` explains GitHub's UNSTABLE merge state. It says whether only non-required checks are red
  ("every required check passes") or a required one is, and names each non-passing check. Before, a red optional
  check read as a bare "UNSTABLE". The gate's own status is never listed.
- `agent-merge-evidence` takes a comment's verdict only from an explicit `Verdict:` line, or `confirm <sha>`. A
  review headed "evidence remedy for HOLD 7db8271e" with `Verdict: PASS` was read as a failure, because verdict words
  in the heading counted. The heading now only names the seat. No `Verdict:` line means no verdict (NONE
  VERIFIABLE), never an inferred failure.
- `agent-project-check` no longer reports seats as stale when `agent-refresh-guidance` says they are current. It
  looked for a startup block named by basename (`context.md`), while OpenRig names it by path (`startup/context.md`).
  The check now asks the refresh itself (`agent-refresh-guidance <P> --json`, new), so the two can't disagree. The
  WARN names each stale seat with its reason. It also ignores OpenRig spec-audit findings that read a Jev decision id
  (`review.merge_gate`) as a seat id; every other finding still WARNs.
- `agent-merge-evidence` works where every seat posts to GitHub as one shared login. A login mapped to `"shared"`
  (or unmapped) takes the reviewer's family from the review's first-line heading via `identityHeadings`, and the
  exact-head rule is unchanged. A status description naming a seat of the author's own family no longer counts as
  an independent review. The heading is self-declared: only as trustworthy as the seats (see REFERENCE).
- `agent-merge-evidence` no longer says CI is MISSING when the base branch has no required checks (no ruleset or
  protection). It reports the check runs and statuses observed on the exact head, and names any failing or
  unfinished one. A check run and a status sharing a name are both shown, and the helper's own review and gate are
  never counted as CI. Any protected base, including one protected only by rules like signatures or required
  reviews, is unchanged.
- `agent-merge-evidence` no longer feeds the gate's own earlier result back to Jev. A re-gate after its own HOLD on
  the same head used to read "failure already posted", so every hold re-held itself. The gate's own status or
  comment is now left out of `ci`, of the merge-state reasons and of the gate's problems. Earlier runs on the head
  are listed in a separate `history` output field that is never sent to Jev.
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
  run.
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
