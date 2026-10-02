# Coordination and human updates

Read when sending a human row, planning a wave, dispatching work or closing a merge.

- Every row to a human (the owner, any `*@external`) gets a short subject: `--summary "<what is now true, or what you
  need>"`, shown as the Slack message's bold title. Without one the `rig` launcher takes the body's first line
  (markdown stripped, at most 80 characters); write it yourself rather than rely on that.
- Human FYIs: send an informational row to the owner (@OWNER@) with `--human-intent update`. It is closed
  automatically once Slack has posted it (`agent-human-inbox-tidy`, every 5 minutes); don't reopen it. A row without
  `--human-intent` counts as a decision and stays open. Decision requests use `--human-intent decision` and
  stay pending until answered: the owner's Slack reply closes a pending row, and parking or claiming it breaks that.
- Visual proof for the owner: an update row to the owner (`--human-intent update`) can carry ONE file,
  `--evidence-ref <absolute path>`: a .png/.jpg/.gif/.webp, an .mp4/.webm/.mov or a .pdf, at most 50 MiB. The daemon
  posts the row's text, then uploads the file into that message's Slack thread; if the upload fails the text still
  lands (the daemon logs "attachment missing"), so the text says what the file shows.
  - When: a witness pass, a finished user-visible feature, a fix for a bug the owner reported. Not every step or PR.
    The lead sends these; QA and the witness give the lead the file's absolute path with their PASS.
  - How: in a Playwright script, `await page.screenshot({ path: dir + "/home.png", fullPage: true })`; for video,
    `browser.newContext({ recordVideo: { dir, size: { width: 1280, height: 720 } } })`, then `await context.close()`
    and pass `await page.video().path()` (a .webm). Over 50 MiB? `agent-video-fit <video>` prints the path of a copy
    that fits (H.264 .mp4, re-encoded only when needed); Slack skips a bigger attachment and only the text lands. The Playwright MCP's `browser_take_screenshot` saves under
    `~/.local/state/agent-stack/playwright-mcp/<your seat>/`, which is scratch: deleted after 48 hours (sooner on a
    client-data project), so copy what you keep into the slice's proof dir or the proof folder below.
  - Where: `$HOME/.cache/<rig>-tmp/<seat>/proof/` (the seat root of the `TMPDIR` rule below), outside every repo and
    never in `/tmp`. Not inside a job's own temp dir: its trap removes it, and the daemon reads the file only when it
    posts, after your command has returned. "Posted" (or the row closing itself) confirms the TEXT only: the daemon
    reads and uploads the file after that receipt. So never delete a proof file because its row posted; keep them,
    and age them out: `find "$HOME/.cache/<rig>-tmp/<seat>/proof" -type f -mtime +7 -delete`.
  - Never on screen: secrets, tokens, passwords or keys, real client or customer data, other projects' windows. Use
    demo or fictional data and test accounts only; crop or redo a capture that shows anything else.

## Projects, missions, slices and waves (OpenRig conventions)
- Work lives in the project workspace (`$OPENRIG_WORK_ROOT`): project.yaml → missions/<m>/ (SPEC, PROGRESS, NOTES, mission.yaml) → slices/<s>/ (SPEC, PROGRESS, PROOF, proof/). Use the `mission-slice-sop` and `queue-handoff` skills; references in `$OPENRIG_HOME/reference/` (sdlc-conventions.md, wave-sdlc.md, product-journey-sdlc.md).
- Waves: slices build in parallel in disjoint file territories; the merge owner merges serially; the independent wave review fires once per wave on top of the per-PR checks. Waves live in each mission.yaml `arrangement.waves` (members = slice SPEC ids), maintained by the lead; the TUI reads only that.
- Every queue row names its mission and slice (`--mission`, `--slice`); the seat `rig` adds `project:<id>` and `worktree_path=`. Don't strip them.
- End every turn by passing the ball (`rig queue handoff`) or parking it WITH a wake (`rig queue block … --wake-after`); never go idle holding work.
- Proof: QA and the merge owner accept each proof-contract item with `rig proof judge` once it is shown to work; readiness in the TUI comes only from those judgments.
- Keep slice/mission status honest; the files serve the product, not the other way round.
- Your AGENTS.md / CLAUDE.local.md carries OpenRig managed blocks (your instructions). Never discard them (`git checkout -- AGENTS.md`, `git restore .`, `git stash -u`, resets) and never commit them: stage your own lines with `git add -p`. A pre-commit hook refuses commits containing them.


## GitHub API is shared (binding)
- Every seat of every rig uses the same GitHub account, and GitHub blocks the whole account for a while when calls burst.
  Never poll in a tight loop. Wait at least 60 seconds between status checks (for example
  `gh pr checks <n> --watch --interval 60`), run at most one waiting loop per seat, and prefer one `gh api` REST call
  over repeated `gh pr view` / `gh pr list` (those use GraphQL).
- On any "rate limit" or "secondary rate limit" error: stop GitHub calls for 2 minutes, then retry once. Do not retry
  in a loop, and do not switch to a different command to get around it.
- The merge owner's 15-minute sweep is the default rhythm for PR status; other seats do not poll PRs they are not
  actively working on.

