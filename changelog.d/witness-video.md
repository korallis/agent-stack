### Added
- New rigs carry the owner's standing rule (2026-10-02): when a task is done (fully merged and fully witnessed), a video
  of the witness goes to the owner in Slack. The witness slice requires a screen video of the end-to-end check, kept
  with the proof; QA (the witness) hands the lead its path; the lead sends one owner FYI row with `--evidence-ref`.
  Witness on staging with test data, and ask the owner first if real client data would show.
- `agent-video-fit VIDEO [OUT]` fits a video under Slack's 50 MiB attachment limit, re-encoding only when needed.
