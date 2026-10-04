### Fixed
- `agent-reroute` judges a Claude Code seat by its live model, read from its own transcript (a confirmed `/model` or
  the latest real assistant turn), not the spec's launch model. Reviewers switched with `/model` had their rows moved
  to another family because the old model was cooling. It also moves only rows that are still actionable: never one
  whose PR merged or closed, whose named head moved, or whose PR can't be read. A refresh or delta review stays with a
  reviewer of the original reviewer's family, or is left for the lead.
