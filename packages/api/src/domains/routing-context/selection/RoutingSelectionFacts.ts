import type { RoutingAccountCapacityV1, RoutingCapacityWindowV1 } from '@cat-cafe/shared';
import type { RoutingSnapshotReadModel } from '../RoutingContextReadService.js';

const windowNames = { five_hour: '5h', seven_day: '7d', monthly: 'month', credits: 'credits', unknown: 'window?' };
const column = (window: RoutingCapacityWindowV1) =>
  `${window.poolKind.replace('codex-', '')}/${windowNames[window.kind]}`;

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
  const columns = [...new Set(accounts.flatMap((account) => account.windows.map(column)))];
  const times = new Map<number, number>();
  const time = (value: number) => {
    if (!times.has(value)) times.set(value, times.size + 1);
    return times.get(value);
  };
  const accountLine = (account: RoutingAccountCapacityV1) => {
    if (account.state === 'unknown') return `unknown(${account.reason ?? 'unverified'})`;
    const cells = columns.map((key) => {
      const matches = account.windows.filter((window) => column(window) === key);
      if (matches.length === 0) return '—';
      // If a producer has several independent windows with the same name, retain each.
      return matches
        .map(
          (window) =>
            `${window.freshness === 'stale' ? 'stale ' : ''}${window.remainingAmount ? `${window.remainingAmount.value} credits` : `${window.remainingPercent}%`}↻${window.resetAt === undefined ? '?' : time(window.resetAt)}`,
        )
        .join(',');
    });
    return `${account.accountLabel ?? '当前号'} ${account.plan ?? ''} ${account.state}${account.reason ? `(${account.reason})` : ''} obs${account.observedAt === undefined ? '?' : time(account.observedAt)}: ${cells.join('|')}`;
  };
  const lines = [
    ...(columns.length ? [`账号观测；applicability unknown。列: ${columns.join('|')}`] : []),
    ...[...current.values()].map(
      ({ cats, account, warnings }) => `${cats.join(',')}: ${accountLine(account)}${warnings}`,
    ),
  ];
  const switchGroups = new Map<string, RoutingAccountCapacityV1[]>();
  for (const { cats, account } of spare.values()) {
    const key = cats.join(',');
    switchGroups.set(key, [...(switchGroups.get(key) ?? []), account]);
  }
  for (const [cats, accounts] of switchGroups)
    lines.push(`需切号才能用(${cats}): ${accounts.map(accountLine).join('; ')}`);
  if (times.size)
    lines.push(
      `UTC ${[...times].map(([value, id]) => `${id}=${new Date(value).toISOString().slice(5, 16)}Z`).join('; ')}；↻?=reset unknown`,
    );
  return lines.join('\n');
}
