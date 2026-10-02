import type { Capacity } from './types.ts';
import { countdown, safe } from './draw.ts';
import { providerName } from './wording.ts';

const singleLine = (value: string) => safe(value.replace(/\s+/g, ' ')).trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const groups = ['blocked', 'waiting', 'unknown'] as const;

function timing(value: string | null | undefined, at: number, kind: 'reset' | 'cooldown'): string {
  const remaining = Number.isFinite(at) ? countdown(value ?? null, at) : 'unknown';
  if (remaining === 'unknown') return `${kind} unknown`;
  if (remaining === 'due') return `${kind === 'reset' ? 'reset' : 'cooldown end'} due (unconfirmed)`;
  return `${kind === 'reset' ? 'reset' : 'cooldown ends'} ${remaining}`;
}

/** Report normalized states, never infer availability from usage or observation coverage.
 * Waiting can be a model-only cooldown; Capacity does not retain that scope or freshness.
 */
export function capacityOutages(capacity: Capacity[], at: number, maxItems = 3): string {
  if (!capacity.length) return 'Account status unknown';
  const rows = capacity.filter(c => c.status !== 'ok').map(c => ({
    account: c,
    name: `${singleLine(providerName(c.provider)) || 'Unknown provider'} ${singleLine(c.label) || singleLine(c.id) || 'unnamed account'}`,
  })).sort((a, b) => groups.indexOf(a.account.status as typeof groups[number]) - groups.indexOf(b.account.status as typeof groups[number])
    || compare(a.name, b.name) || compare(a.account.id, b.account.id));
  if (!rows.length) return 'No account outages reported';
  const limit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : 3;
  const selected = rows.slice(0, limit);
  const parts = groups.flatMap(status => {
    const entries = selected.filter(row => row.account.status === status).map(({ account: c, name }) => {
      // The adapter repeats this exact cooldown timestamp in its reason. Show it once, labelled.
      const suffix = c.cooldownUntil ? ` until ${c.cooldownUntil}` : '';
      const reason = suffix && c.reason.endsWith(suffix) ? c.reason.slice(0, -suffix.length) : c.reason;
      const details = [singleLine(reason) || 'reason unknown', timing(c.resetAt, at, 'reset')];
      if (c.cooldownUntil != null) details.push(timing(c.cooldownUntil, at, 'cooldown'));
      return `${name} (${details.join('; ')})`;
    });
    return entries.length ? [`${status[0].toUpperCase()}${status.slice(1)}: ${entries.join(', ')}`] : [];
  });
  const omitted = rows.length - selected.length;
  if (omitted) parts.push(`+${omitted} more account${omitted === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
