#!/usr/bin/env bash
# Fails if any acceptance journey tests the app from the inside instead of the way a person uses it.
# Journeys (tests/acceptance/**, except fixtures/) may only: visit pages, find things by what a person sees
# (getByRole / getByLabel / getByText / getByPlaceholder / getByAltText / getByTitle), click, type, press keys,
# and assert what appears on screen. Setup a person cannot do belongs in tests/acceptance/fixtures/.
set -uo pipefail
dir=${1:-tests/acceptance}
[ -d "$dir" ] || { echo "no $dir yet"; exit 0; }
mapfile -t specs < <(rg --files "$dir" -g '*.{ts,js,mjs}' -g '!**/fixtures/**' -g '!**/*.d.ts' 2>/dev/null)
[ ${#specs[@]} -gt 0 ] || { echo "no journeys yet"; exit 0; }
fail=0
check() { # <regex> <what a reviewer should read>
  local hits; hits=$(rg -n --no-heading -e "$1" "${specs[@]}" 2>/dev/null) || return 0
  echo "::error::$2"; echo "$hits" | sed 's/^/    /'; fail=1
}
check '\.(evaluate|evaluateHandle|\$eval|\$\$eval)\('                 'Runs code inside the page. A person cannot do that.'
check '\b(page|context)\.route\(|routeFromHAR|unroute\('               'Mocks the network. Journeys must hit the real app.'
check '\brequest\.(get|post|put|patch|delete|fetch|head)\(|APIRequestContext|\bfetch\(|axios' 'Calls an API directly. Act through the UI instead.'
check 'addInitScript|addCookies|clearCookies|storageState|localStorage|sessionStorage|setExtraHTTPHeaders' 'Injects state to skip steps. Log in and navigate like a person (shared UI login belongs in fixtures/).'
check '\.locator\(|\.\$\(|\.\$\$\(|xpath=|css=|>>'                   'Finds elements by CSS/XPath. Use getByRole/getByLabel/getByText etc. (what a person sees).'
check 'getByTestId|data-testid'                                        'Finds elements by test id, which a person cannot see.'
check '\.(skip|only|fixme)\('                                          'Skipped or focused journey.'
check 'waitForTimeout\('                                               'Fixed sleep. Wait for what a person would see instead (expect(...).toBeVisible()).'
check 'setContent\(|goto\(\s*["'"'"'`](data:|file:)'                   'Replaces the real page.'
check 'require\(|from\s+["'"'"'](@/|~/|[./]*\.\./(\.\./)*(src|app|lib|server|packages|db)/)' 'Imports application code. Journeys must not know the internals.'
for f in "${specs[@]}"; do
  rg -q 'expect\(' "$f" || { echo "::error::$f has no assertion about what the person sees."; fail=1; }
  rg -q 'getBy(Role|Label|Text|Placeholder|AltText|Title)\(' "$f" || { echo "::error::$f never finds anything the way a person would (getByRole/getByLabel/getByText...)."; fail=1; }
done
[ $fail -eq 0 ] && echo "human-perspective: ${#specs[@]} journey file(s) OK"
exit $fail
