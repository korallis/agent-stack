### Fixed
- The documented merge-evidence review heading (`docs/REFERENCE.md`) counts Grok reviewers and numbered seats:
  `^## (review|impl|tests)-(claude|codex|kimi|grok)-?\d*`. The old example, `^## review-(claude|codex|kimi)`, dropped
  Grok reviews from merge evidence, so the merge gate held PRs whose only other-family review was by Grok.
