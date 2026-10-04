### Fixed
- `agent-reroute` never moves a review row to a seat that already reviewed that PR's exact head. It reads independent-review
  statuses, `## review-<seat>` comments naming the head, and GitHub reviews on the head commit. A third or
  other-family review row also never goes to a family already counted. With no eligible seat, or unreadable review
  evidence, the row stays with the lead and the reason. A third-family review had been rerouted to the head's primary
  reviewer while the third family was cooling.
