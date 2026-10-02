// Public docs use only the invented v3 snapshot, rendered by production code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SHOTS, DEMO, FIXTURE, screenOf, html } from '../console/docs/make-assets.mjs';
import { initialState, key } from '../console/src/v3/controller.ts';
import { commandItems } from '../console/src/v3/render.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(join(repo, 'README.md'), 'utf8');
const fixtureText = fs.readFileSync(join(repo, FIXTURE), 'utf8'), fixture = JSON.parse(fixtureText);
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const run = args => spawnSync(process.execPath, ['console/src/main.ts', ...args], {
  cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(repo, 'nonexistent-home') }, timeout: 30000,
});

test('README: every checkout command renders its documented v3 view without a live source', () => {
  const blocks = [...readme.matchAll(/```bash\n(# Runs from a checkout[\s\S]*?)```/g)];
  assert.equal(blocks.length, 1);
  const lines = blocks[0][1].split('\n').map(l => l.replace(/\s+#\s.*$/, '').trim()).filter(l => l && !l.startsWith('#'));
  assert.equal(lines.shift(), 'cd ~/Projects/agent-stack');
  assert.equal(lines.length, 6);
  for (const [i, line] of lines.entries()) {
    assert.ok(line.startsWith('node console/src/main.ts '), line);
    const args = line.split(/\s+/).slice(2);
    assert.equal(args[args.indexOf('--fixture') + 1], FIXTURE);
    assert.ok(!args.includes('--legacy'));
    const result = run([...args, '--once', '--size', '160x50', '--color', '0']);
    assert.equal(result.status, 0, line + '\n' + result.stderr);
    assert.match(plain(result.stdout), SHOTS[i].expect, line);
    assert.match(plain(result.stdout), /neutral fixture/);
  }
  const legacy = readme.match(/`node console\/src\/main\.ts (--legacy [^`]+)`/);
  assert.ok(legacy, 'old views require explicit --legacy');
  const result = run([...legacy[1].split(/\s+/), '--once', '--size', '160x50', '--color', '0']);
  assert.equal(result.status, 0, result.stderr); assert.match(plain(result.stdout), /MISSION CONTROL/);
});

test('README: documented navigation opens every view and both overlays', () => {
  const state = initialState();
  for (const [i, view] of ['fleet', 'team', 'agent', 'task', 'pr', 'capacity'].entries()) {
    key(state, String(i + 1), fixture); assert.equal(state.view, view);
  }
  key(state, '?', fixture); assert.equal(state.help, true);
  key(state, '\x1b', fixture); assert.equal(state.help, false);
  key(state, ':', fixture); for (const ch of 'cobalt') key(state, ch, fixture);
  assert.ok(commandItems(fixture, state.command).some(item => item.view === 'team' && item.id === 'cobalt'));
  key(state, '\x1b', fixture); assert.equal(state.command, null);
  const selected = state.selected;
  key(state, ']', fixture); assert.equal(state.scroll, 1);
  key(state, '\x1b[6~', fixture); assert.equal(state.scroll, 6);
  key(state, '\x1b[5~', fixture); assert.equal(state.scroll, 1);
  key(state, '[', fixture); assert.equal(state.scroll, 0); assert.equal(state.selected, selected);
  key(state, 'p', fixture); assert.equal(state.paused, true);
  assert.equal(key(state, 'r', fixture), 'refresh'); assert.equal(key(state, 'q', fixture), 'quit');
  for (const k of ['`1` to `6`', '`[` `]`', '`PgUp` `PgDn`', '`⏎`', '`:`', '`esc`', '`p`', '`r`', '`?`', '`q`']) assert.ok(readme.includes(`| ${k} |`), k);
});

// Parse GIF image blocks, skipping compressed sub-blocks rather than counting bytes in pixel data.
function gifFrames(data) {
  assert.match(data.toString('ascii', 0, 6), /^GIF8[79]a$/);
  let at = 13 + (data[10] & 128 ? 3 * 2 ** ((data[10] & 7) + 1) : 0), frames = 0;
  const blocks = () => { for (;;) { const n = data[at++]; assert.ok(n !== undefined); if (!n) break; at += n; assert.ok(at <= data.length); } };
  while (at < data.length) {
    const marker = data[at++];
    if (marker === 0x3b) return frames;
    if (marker === 0x21) { at++; blocks(); }
    else { assert.equal(marker, 0x2c); const packed = data[at + 8]; at += 9; if (packed & 128) at += 3 * 2 ** ((packed & 7) + 1); at++; blocks(); frames++; }
  }
  assert.fail('GIF trailer missing');
}

test('docs assets: every generated view and tour frame contains its promised content', () => {
  const result = spawnSync(process.execPath, ['console/docs/make-assets.mjs', '--check'], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /rendered 8 images and 8 demo frames from console\/fixtures\/v3.json/);
  for (const shot of [...SHOTS, ...DEMO.steps.map(step => ({ ...step, size: DEMO.size }))]) {
    const { screen } = screenOf(shot), text = screen.lines().join('\n');
    assert.ok(shot.expect instanceof RegExp); assert.match(text, shot.expect);
    assert.doesNotMatch(html(screen, 'neutral'), /\/home\/|\/Users\/|https?:\/\//);
  }
  const dir = join(repo, 'docs/assets/rig-console'), files = fs.readdirSync(dir);
  assert.deepEqual(files.sort(), [...SHOTS.map(s => `${s.name}.png`), 'demo.gif'].sort());
  let bytes = 0;
  for (const shot of SHOTS) {
    const data = fs.readFileSync(join(dir, `${shot.name}.png`)); bytes += data.length;
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(data.readUInt32BE(16) >= 1000 && data.readUInt32BE(20) >= 700, shot.name);
  }
  const gif = fs.readFileSync(join(dir, 'demo.gif')); bytes += gif.length;
  assert.equal(gifFrames(gif), DEMO.steps.length);
  assert.ok(bytes < 3 * 1024 * 1024, `assets stay small: ${bytes} bytes`);
});

test('docs fixture stays neutral and adapter documentation names the production contract', () => {
  assert.equal(FIXTURE, 'console/fixtures/v3.json'); assert.match(fixture.source, /neutral fixture.*invented/);
  assert.doesNotMatch(fixtureText, /\/home\/|\/Users\/|github\.com|@[a-z]+\.(com|io|dev)\b/i);
  assert.ok(fixture.prs.every(pr => new URL(pr.url).hostname === 'example.org'));
  const doc = fs.readFileSync(join(repo, 'console/docs/adapter.md'), 'utf8');
  for (const token of ['Snapshot', 'snapshot()', 'start(onChange)', 'select(', 'refresh()', 'stop()', 'null', 'unknown', 'stale', 'Ratatui', 'factory', 'progressLabel', 'lastDecision', 'cooldownUntil', 'weekly']) assert.ok(doc.includes(token), token);
});
