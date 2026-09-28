#!/usr/bin/env bash
# Locked tests: implementation PRs may not touch the acceptance journeys or the guards that check them.
#  - tests/acceptance/**  may change only on a tests/* branch (the test-author seat), and such a PR may change nothing else.
#  - scripts/guards/**, playwright.config.*, .github/**  need the PR label "owner-approved" (added by the owner).
# Env (set by CI): BASE_SHA, HEAD_REF (PR branch), PR_LABELS (comma-separated).
set -euo pipefail
base=${BASE_SHA:?BASE_SHA required}; ref=${HEAD_REF:-}; labels=",${PR_LABELS:-},"
mapfile -t changed < <(git diff --name-only "$base"...HEAD)
tests=(); infra=(); other=()
for f in "${changed[@]}"; do
  case "$f" in
    tests/acceptance/*) tests+=("$f");;
    scripts/guards/*|playwright.config.*|.github/*) infra+=("$f");;
    *) other+=("$f");;
  esac
done
fail=0
if [ ${#tests[@]} -gt 0 ]; then
  if [[ "$ref" != tests/* ]]; then echo "::error::Acceptance journeys changed on '$ref'. Only the test-author seat changes them, on a tests/* branch."; printf '    %s\n' "${tests[@]}"; fail=1; fi
  if [ ${#other[@]} -gt 0 ] || [ ${#infra[@]} -gt 0 ]; then echo "::error::A tests/* PR must change only tests/acceptance/**."; printf '    %s\n' "${other[@]}" "${infra[@]}"; fail=1; fi
fi
if [[ "$ref" == tests/* ]] && [ ${#tests[@]} -eq 0 ]; then echo "::error::tests/* branch without acceptance-test changes."; fail=1; fi
if [ ${#infra[@]} -gt 0 ] && [[ "$labels" != *",owner-approved,"* ]]; then echo "::error::Guards, Playwright config or CI changed without the owner-approved label."; printf '    %s\n' "${infra[@]}"; fail=1; fi
[ $fail -eq 0 ] && echo "protected-paths: OK (${#changed[@]} files; tests=${#tests[@]} infra=${#infra[@]})"
exit $fail
