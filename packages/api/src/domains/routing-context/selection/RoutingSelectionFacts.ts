import type { RoutingAccountCapacityV1, RoutingCapacityWindowV1 } from '@cat-cafe/shared';
import type { RoutingSnapshotReadModel } from '../RoutingContextReadService.js';

const windowNames = { five_hour: '5h', seven_day: '7d', monthly: 'month', credits: 'credits', unknown: 'window?' };
const column = (window: RoutingCapacityWindowV1) =>
  window.poolKind === 'claude-subscription'
    ? `Claude/${window.windowKey === 'seven_day_overage_included' ? 'Fable7d' : window.windowKey === 'seven_day' ? '7d' : window.windowKey === 'five_hour' ? '5h' : `${window.windowKey}${window.observedModel ? `@${window.observedModel}` : ''}`}`
    : `${window.poolKind.replace('codex-', '')}/${windowNames[window.kind]}`;
const columnFamily = (name: string) => (name.startsWith('Claude/') ? 'Claude' : 'Codex');

/** A compact table shares labels/timestamps, never balances or pool applicability. */
export function routingSelectionFacts(model: RoutingSnapshotReadModel): string {
  if (model.resolution.state !== 'fresh') return 'unknown: routing source unavailable';
  const current = new Map<string, { cats: string[]; account: RoutingAccountCapacityV1; warnings: string }>();
  const spare = new Map<string, { cats: string[]; account: RoutingAccountCapacityV1 }>();
  for (const candidate of model.resolution.snapshot.candidates) {
    const account = candidate.binding.capacityFacts?.current ?? {
      state: 'unknown' as const,
      reason: 'binding_unknown' as const,
      windows: [],
    };
    const warnings =
      candidate.availability === 'available'
        ? ''
        : ` [${candidate.availability}: ${candidate.reasons.map((reason) => reason.code).join(',')}]`;
    const key = JSON.stringify([account, warnings]);
    const group = current.get(key) ?? { cats: [], account, warnings };
    group.cats.push(candidate.binding.catId);
    current.set(key, group);
    for (const account of candidate.binding.capacityFacts?.switchRequired ?? []) {
      const key = account.evidenceRef ?? JSON.stringify(account);
      const group = spare.get(key) ?? { cats: [], account };
      group.cats.push(candidate.binding.catId);
      spare.set(key, group);
    }
  }
  const accounts = [...current.values(), ...spare.values()].map((group) => group.account);
  const columnGroups = new Map<string, string[]>();
  for (const key of new Set(accounts.flatMap((account) => account.windows.map(column)))) {
    const family = columnFamily(key);
    columnGroups.set(family, [...(columnGroups.get(family) ?? []), key]);
  }
  const columns = [...columnGroups.values()].flat();
  const groups = new Map<string, string>();
  for (const { cats } of current.values()) if (cats.length > 1) groups.set(cats.join(','), `G${groups.size + 1}`);
  const times = new Map<string, number>();
  const time = (value: number) => {
    const stamp = `${new Date(value).toISOString().slice(0, 16)}Z`;
    if (!times.has(stamp)) times.set(stamp, times.size + 1);
    return times.get(stamp);
  };
  const accountLine = (account: RoutingAccountCapacityV1) => {
    if (account.state === 'unknown' && !account.windows.length) return `unknown(${account.reason ?? 'unverified'})`;
    const allStale = account.state === 'stale' && account.windows.every((window) => window.freshness === 'stale');
    const families = new Set(account.windows.map((window) => columnFamily(column(window))));
    const cells = columns
      .filter((key) => families.has(columnFamily(key)))
      .map((key) => {
        const matches = account.windows.filter((window) => column(window) === key);
        if (matches.length === 0) return '—';
        // If a producer has several independent windows with the same name, retain each.
        return matches
          .map(
            (window) =>
              `${!allStale && window.freshness === 'stale' ? 'stale ' : ''}${window.remainingAmount ? `${window.remainingAmount.value} credits` : `${window.remainingPercent}%`}↻${window.resetAt === undefined ? '?' : time(window.resetAt)}`,
          )
          .join(',');
      });
    const reason = account.reason && account.reason !== 'observation_stale' ? `(${account.reason})` : '';
    return `${account.accountLabel ?? '当前号'} ${account.plan ?? ''} ${account.state}${reason} obs${account.observedAt === undefined ? '?' : time(account.observedAt)}: ${cells.join('|')}`;
  };
  const lines = [
    ...(columns.length
      ? [
          `账号剩余；applicability unknown。列: ${columnGroups.size > 1 ? [...columnGroups].map(([family, keys]) => `${family}[${keys.map((key) => key.replace('Claude/', '')).join('|')}]`).join(';') : columns.join('|')}`,
        ]
      : []),
    ...[...current.values()].map(
      ({ cats, account, warnings }) =>
        `${groups.has(cats.join(',')) ? `${groups.get(cats.join(','))}=` : ''}${cats.join(',')}: ${accountLine(account)}${warnings}`,
    ),
  ];
  const switchGroups = new Map<string, RoutingAccountCapacityV1[]>();
  for (const { cats, account } of spare.values()) {
    const key = cats.join(',');
    switchGroups.set(key, [...(switchGroups.get(key) ?? []), account]);
  }
  for (const [cats, accounts] of switchGroups)
    lines.push(`需切号才能用(${groups.get(cats) ?? cats}): ${accounts.map(accountLine).join('; ')}`);
  if (times.size) {
    const month = [...times.keys()][0].slice(0, 7);
    const commonMonth = [...times.keys()].every((stamp) => stamp.startsWith(month));
    lines.push(
      `UTC${commonMonth ? ` ${month}` : ''} ${[...times].map(([stamp, id]) => `${id}=${stamp.slice(commonMonth ? 8 : 5)}`).join('; ')}${accounts.some((account) => account.windows.some((window) => window.resetAt === undefined)) ? '；↻?=reset unknown' : ''}`,
    );
  }
  return lines.join('\n');
}
