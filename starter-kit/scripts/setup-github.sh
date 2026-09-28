#!/usr/bin/env bash
# One-time GitHub setup for a new repo made from the starter kit (run by the owner or operator, needs admin).
# Usage: scripts/setup-github.sh <owner/repo>
set -euo pipefail
repo=${1:?owner/repo}
gh label create owner-approved --repo "$repo" --color B60205 --description "Owner approved a change to guards, Playwright config or CI" 2>/dev/null || true
gh api -X PUT "repos/$repo/branches/main/protection" --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["guards", "app", "acceptance", "independent-review", "jev-merge"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON
echo "Branch protection set on $repo: guards, app, acceptance, independent-review and jev-merge must pass."
