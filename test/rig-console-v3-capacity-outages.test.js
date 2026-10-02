import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityOutages } from '../console/src/v3/capacity-outages.ts';

const at = Date.parse('2026-10-03T12:00:00Z');
const account = (id, extra = {}) => ({
  id, provider: 'claude', label: id, status: 'blocked', reason: 'Over limit',
  used: null, weekly: null, resetAt: null, cooldownUntil: null, credits: null, history: [], ...extra,
});

test('each blocked account keeps its own reset instead of borrowing the provider earliest reset', () => {
  const line = capacityOutages([
    account('Two', { resetAt: '2026-10-03T14:00:00Z' }),
    account('One', { resetAt: '2026-10-03T12:30:00Z' }),
  ], at);
  assert.equal(line, 'Blocked: Claude One (Over limit; reset in 30m), Claude Two (Over limit; reset in 2h 0m)');
});

test('cooldown stays distinct from quota reset and does not promise availability', () => {
  const line = capacityOutages([account('One', {
    status: 'waiting', reason: 'Rate limited until 2026-10-03T12:05:00Z',
    cooldownUntil: '2026-10-03T12:05:00Z', resetAt: '2026-10-03T14:00:00Z',
  })], at);
  assert.equal(line, 'Waiting: Claude One (Rate limited; reset in 2h 0m; cooldown ends in 5m)');
  assert.doesNotMatch(line, /available|back in|ready/i);
});

test('unknown and invalid reset times remain unknown even when cooldown is known', () => {
  for (const resetAt of [null, 'not-a-date']) {
    const line = capacityOutages([account('One', {
      status: 'waiting', reason: '', resetAt, cooldownUntil: '2026-10-03T12:05:00Z',
    })], at);
    assert.match(line, /reason unknown; reset unknown; cooldown ends in 5m/);
    assert.doesNotMatch(line, /reset in 5m/);
  }
  assert.match(capacityOutages([account('One', { status: 'waiting', cooldownUntil: 'bad' })], at), /cooldown unknown/);
});

test('elapsed timers leave reported blockage intact and do not claim reset success', () => {
  const line = capacityOutages([account('One', {
    reason: 'Disabled', resetAt: '2026-10-03T11:59:00Z', cooldownUntil: '2026-10-03T11:58:00Z',
  })], at);
  assert.match(line, /^Blocked: Claude One \(Disabled; reset due \(unconfirmed\); cooldown end due \(unconfirmed\)\)$/);
  assert.doesNotMatch(line, /available|ready|restored/i);
});

test('usage coverage and over-100 credit usage do not manufacture outages or availability', () => {
  assert.equal(capacityOutages([], at), 'Account status unknown');
  const ok = [account('One', { status: 'ok', used: 150, credits: 'Using credits' }), account('Two', { status: 'ok' })];
  assert.equal(capacityOutages(ok, at), 'No account outages reported');
  assert.equal(capacityOutages([...ok, account('Three', { status: 'unknown', reason: '' })], at),
    'Unknown: Claude Three (reason unknown; reset unknown)');
});

test('bounded groups prioritize blocked then waiting then unknown without mutating or hiding omissions', () => {
  const rows = [account('Zulu', { status: 'unknown' }), account('Beta', { status: 'waiting' }), account('Alpha'), account('Omega')];
  const before = structuredClone(rows);
  const line = capacityOutages(rows, at, 2);
  assert.equal(line, 'Blocked: Claude Alpha (Over limit; reset unknown), Claude Omega (Over limit; reset unknown) · +2 more accounts');
  assert.deepEqual(rows, before);
  assert.equal(capacityOutages([...rows].reverse(), at, 2), line);
  assert.match(capacityOutages(rows, at), /Waiting: Claude Beta.*\+1 more account$/);
});

test('provider labels disambiguate account names and untrusted fields stay on one safe line', () => {
  const line = capacityOutages([
    account('one', { label: 'Shared', provider: 'codex' }),
    account('two', { label: 'Shared\n', provider: 'xai', reason: '\x1b[31mRate\nlimited\x1b[0m' }),
  ], at);
  assert.match(line, /Codex Shared/);
  assert.match(line, /Grok Shared \(Rate limited;/);
  assert.doesNotMatch(line, /[\n\r\x1b]/);
});

test('bad reference time stays unknown and item-limit edge cases do not produce false healthy state', () => {
  assert.match(capacityOutages([account('One', { resetAt: '2026-10-03T14:00:00Z' })], NaN), /reset unknown/);
  assert.equal(capacityOutages([account('One')], at, 0), '+1 more account');
  assert.match(capacityOutages([account('One')], at, NaN), /^Blocked:/);
});
