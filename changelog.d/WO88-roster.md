### Added
- `rig/template/standard.yaml`: the 16-seat project team from the 2026-10-02 resize (WO88). Two coordinators, an
  architect, four implementers (two on native Grok 4.7 Build Fast, one Sonnet 5.5 UI, one Sol), two test authors (Grok
  and Sol), three reviewers of three families (Grok 4.7, Kimi K3 256k, Sol), two QA (Opus, Sol), a merge owner and a
  recovery seat. Grok and Kimi seats are terminal members run by `agent-native-seat`. `agent-project-new --team
  standard` and `openrig-update --validate` know it.

### Changed
- CULTURE.md "Models and routing" follows Jev `intake.specialist` (2026-10-02) across all four families, keeps a seat
  on its model (route work, don't switch models), and limits 1M windows to leads and architects.
- `agent-project-check` FAILs a `[1m]` model on any seat outside the lead and architect pods, in the rig spec and on
  live seats (a 1M seat re-sends up to a million tokens every turn), with the `rig seat set-model` remedy.
- Kimi reviewers in every template use `kimi-k3-256k` instead of `kimi-k3[1m]`.
