// WO100: agent-stack's own CI picks the local runner (label korallis-local) when the repo variable CI_LOCAL is 1,
// except for pull requests from forks, which always run on GitHub's hosted runner; stale runs are cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const wf = fs.readFileSync(join(repo, ".github/workflows/test.yml"), "utf8");
const EXPR = "${{ (vars.CI_LOCAL == '1' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)) && fromJSON('[\"self-hosted\",\"linux\",\"korallis-local\"]') || 'ubuntu-24.04' }}";

test("every job runs local only with CI_LOCAL=1 and never for a fork PR; hosted otherwise; stale runs cancel", () => {
  const runsOn = [...wf.matchAll(/^\s+runs-on: (.*)$/gm)].map((m) => m[1]);
  assert.ok(runsOn.length >= 1);
  for (const r of runsOn) assert.equal(r, EXPR);
  assert.match(wf, /concurrency:\n\s+group: test-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/);
  // the expression's three outcomes, evaluated the way Actions does (&& / || return operands)
  const pick = (ciLocal, event, head, base = "korallis/agent-stack") =>
    (ciLocal === "1" && (event !== "pull_request" || head === base)) && ["self-hosted", "linux", "korallis-local"] || "ubuntu-24.04";
  assert.deepEqual(pick("1", "pull_request", "korallis/agent-stack"), ["self-hosted", "linux", "korallis-local"]);
  assert.deepEqual(pick("1", "push", undefined), ["self-hosted", "linux", "korallis-local"]);
  assert.equal(pick("1", "pull_request", "someone/agent-stack"), "ubuntu-24.04", "a fork PR never reaches the local runner");
  assert.equal(pick("", "push", undefined), "ubuntu-24.04", "no local runner registered: hosted");
});

test("setup-python runs only on hosted runners (no Arch builds); the local runner uses the host's python3 with pyyaml", () => {
  assert.match(wf, /- uses: actions\/setup-python@v5\n\s+if: runner\.environment == 'github-hosted'\n/);
  assert.match(wf, /if \[ "\$RUNNER_ENVIRONMENT" = github-hosted \]; then python -m pip install --quiet pyyaml\n\s+else python3 -c 'import yaml' \|\| \{ echo "::error::the local runner host needs python3 with pyyaml"; exit 1; \}; fi/);
});
