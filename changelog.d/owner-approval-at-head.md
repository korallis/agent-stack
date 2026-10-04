### Fixed
- `agent-merge-evidence`: a risky PR also needs the approver's comment naming its exact head, since labels don't move with
  the head. The comment's own first line reads "owner-approved … applied|re-confirmed|confirmed by operator-agent@kernel
  at [refreshed] head <full sha>" (`AGENT_MERGE_EVIDENCE_APPROVER` overrides the seat). Without it: "MISSING: owner
  approval not confirmed at this head", in both the two-family and reduced-review modes. All comments are read, since
  an approval often also reads as a gate report.
