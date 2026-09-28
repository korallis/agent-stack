# @PROJECT@: rules for every agent

These rules are binding for every seat. The rig culture (CULTURE.md) adds team rules; where they conflict, this file wins.

## What we are building
- The plan: `docs/PLAN.md` (written by the owner).
- The feature list: `features.json` (produced by the architect, approved by the owner). A feature is done only when
  its locked acceptance journeys pass and the QA seat has used it by hand; then the lead sets `passes: true`.
- Progress log: `PROGRESS.md` (one line per merged feature). Daily summaries: `docs/summary/`.

## How to run it
- Install: `npm ci`
- Start for tests: `npm run start:test` (must serve the app on http://127.0.0.1:3000 with test data)
- Unit tests (optional, never proof of done): `npm test`
- Acceptance journeys: `npx playwright test` (desktop and phone)
- Held-out journeys (merge owner only): `E2E_TEST_DIR=@HELDOUT@ npx playwright test`

## Testing from a person's perspective
- Proof of done is a person using the app: see `tests/acceptance/README.md`. CI checks this
  (`scripts/guards/check-human-perspective.sh`) and blocks implementation PRs that touch `tests/acceptance/`
  (`scripts/guards/check-protected-paths.sh`).
- Before handing off, implementers run their feature's journeys and walk the main journey once in the browser.
- The QA seat always does a hands-on pass and attaches screenshots before review.

## Working rules
- Search with `rg` / `rg --files` / `fd`. Put tables you pass to other seats in TOON (`... | toon`).
- Branches: implementers `agent/<seat>`, test authors `tests/<feature-id>`. PRs are ready, never drafts.
- Commit identity: @COMMIT_IDENTITY@
- Secrets live only in local env files and the hosting provider. Never in code, tests, logs or PRs.
- Changes to `scripts/guards/`, `playwright.config.ts` or `.github/` need the owner's `owner-approved` label.
