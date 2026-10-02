### Changed
- `agent-operator-watch` checks the proxy before waking the operator, through the new `agent-servable` (dispatch's
  eligibility). While the operator's model can't be served (every credential cooling on it, so each turn ends in the
  proxy's 429), it holds the wake. When the model is served again it sends one resume; if the hold lasts 30 minutes it
  sends the owner one informational row. It never switches a model or an account, and an unreadable proxy status holds
  nothing.
