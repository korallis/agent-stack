import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(repo, f), 'utf8');

test('the repo is Apache-2.0: canonical LICENSE text, a NOTICE naming third-party material, third-party licences kept', () => {
  // byte-identical to https://www.apache.org/licenses/LICENSE-2.0.txt, so license detection and reviewers see the real text
  assert.equal(createHash('sha256').update(readFileSync(join(repo, 'LICENSE'))).digest('hex'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  const notice = read('NOTICE');
  assert.match(notice, /^agent-stack\nCopyright 2026 The agent-stack authors\n/);
  assert.match(notice, /OpenRig \(https:\/\/github\.com\/mvschwarz\/openrig\), Apache License 2\.0/);
  assert.match(notice, /pstack \(https:\/\/github\.com\/cursor\/plugins\/tree\/main\/pstack\), MIT License/);
  for (const dir of ['patches/openrig', 'test/fixtures/openrig-0.6.3-slack', 'test/fixtures/openrig-0.6.3-tmux']) assert.ok(existsSync(join(repo, dir)), dir);
  // every skill that ships its own licence is named in NOTICE, so nothing third-party is silently relicensed
  const licensed = readdirSync(join(repo, 'skills')).filter((s) => existsSync(join(repo, 'skills', s, 'LICENSE')));
  assert.ok(licensed.length >= 6, licensed.join(', '));
  for (const s of licensed) assert.match(notice, new RegExp(`skills/${s}\\b`), s);
  assert.equal(JSON.parse(read('jev/package.json')).license, 'Apache-2.0');
  assert.match(read('README.md'), /## License\n\nagent-stack is licensed under the \[Apache License 2\.0\]\(LICENSE\)/);
});
