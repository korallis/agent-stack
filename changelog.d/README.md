# changelog.d

One file per change, named after its work order or topic (`WO57.md`, `seat-handover-wakes.md`), holding the bullet(s)
for CHANGELOG.md and the section they go under:

```markdown
### Fixed
- `agent-net-summary` …
```

Pull requests add a file here and never edit CHANGELOG.md, so open PRs don't conflict with each other. The merge owner
folds the files into CHANGELOG.md (newest first, under `## [Unreleased]`) and deletes them, in one commit.
