/** Account-owner projection. Private principal, credential and account references never leave this module. */
import { createHash } from 'node:crypto';
import {
  type AccountConfig,
  type AccountQuotaObservation,
  accountQuotaOwnerMatches,
  type CatConfig,
  type CodexAccountIdentity,
  type RoutingAccountCapacityV1,
  type RoutingCandidateBindingV1,
  type RoutingCapacityWindowV1,
} from '@cat-cafe/shared';
import { accountToRuntimeProfile } from './account-resolver.js';
import { readAccountStoreSnapshot } from './account-store-snapshot.js';
import { resolveBoundAccountRefForCat, usesNativeToolConfiguration } from './cat-account-binding.js';
import { inspectCodexLogin, sameCodexIdentity } from './codex-account-identity.js';
import { resolveCodexAccountLaunch } from './codex-account-launch.js';

// Read-only cache age, independent from provider reset schedules. No network work on a dispatch path.
export const ROUTING_CAPACITY_MAX_AGE_MS = 10 * 60_000;
const opaque = (prefix: string, value: unknown) =>
  `${prefix}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const unknown = (reason: RoutingAccountCapacityV1['reason']): RoutingAccountCapacityV1 => ({
  state: 'unknown',
  reason,
  windows: [],
});

function codexWindowKind(label: string, pool: string): RoutingCapacityWindowV1['kind'] {
  if (pool === 'codex-overflow') return 'credits';
  if (label === '5小时使用限额' || label.endsWith(' 5小时使用限额')) return 'five_hour';
  if (label === '每周使用限额' || label.endsWith(' 每周使用限额')) return 'seven_day';
  return 'unknown';
}

function projectWindows(
  items: AccountQuotaObservation['items'],
  identity: CodexAccountIdentity,
): RoutingCapacityWindowV1[] | undefined {
  if (items.length === 0 || items.length > 16) return undefined;
  const result: RoutingCapacityWindowV1[] = [];
  for (const item of items) {
    // Every simultaneous constraint must be interpretable. Never silently drop a limiting window.
    if (!item.poolId || !item.percentKind) return undefined;
    const resetAt = item.resetsAt === undefined ? undefined : Date.parse(item.resetsAt);
    if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt < 0)) return undefined;
    result.push({
      poolId: opaque('quota-pool', ['openai', identity.userId, identity.workspaceId, item.poolId]),
      poolKind: ['codex-main', 'codex-spark', 'codex-review', 'codex-overflow'].includes(item.poolId)
        ? (item.poolId as Exclude<RoutingCapacityWindowV1['poolKind'], 'unknown'>)
        : 'unknown',
      applicability: 'unknown',
      freshness: 'stale',
      kind: codexWindowKind(item.label, item.poolId),
      ...(item.poolId === 'codex-overflow'
        ? { remainingAmount: { value: item.usedPercent, unit: 'credits' as const } }
        : { remainingPercent: item.percentKind === 'remaining' ? item.usedPercent : 100 - item.usedPercent }),
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }
  return result;
}

function projectAccount(ref: string, account: AccountConfig, root: string, now: number): RoutingAccountCapacityV1 {
  if (account.clientId !== 'openai' || account.authType !== 'oauth' || account.baseUrl)
    return unknown('provider_unverified');
  const profile = accountToRuntimeProfile(ref, account, undefined, root);
  const launch = resolveCodexAccountLaunch(profile, { cwd: root });
  const login = inspectCodexLogin(launch.credentialHome, root);
  if (
    login.status !== 'ready' ||
    (account.codex && (!account.codex.prepared || !sameCodexIdentity(account.codex.identity, login.identity)))
  )
    return unknown('principal_unverified');
  const quota = account.quota;
  if (!quota) return unknown('observation_missing');
  if (!accountQuotaOwnerMatches(quota, ref, login.identity)) return unknown('principal_unverified');
  const reading = quota.status === 'ok' ? quota : quota.lastSuccess;
  if (!reading) return unknown('refresh_failed');
  const windows = projectWindows(reading.items, login.identity);
  if (!windows) return unknown('no_supported_pool');
  const validUntil = reading.observedAt + ROUTING_CAPACITY_MAX_AGE_MS;
  const fresh = quota.status === 'ok' && reading.observedAt <= now && now < validUntil;
  for (const window of windows)
    window.freshness = fresh && (window.resetAt === undefined || now < window.resetAt) ? 'fresh' : 'stale';
  const label = account.displayName?.trim();
  const plan = login.identity.planType ?? account.codex?.identity?.planType;
  return {
    state: fresh ? 'fresh' : 'stale',
    ...(!fresh
      ? {
          reason: quota.status !== 'ok' ? ('refresh_failed' as const) : ('observation_stale' as const),
        }
      : {}),
    ...(label && label.length <= 80 && label !== ref && !label.includes('@') ? { accountLabel: label } : {}),
    bindingRevision: launch.accountRevision,
    evidenceRef: opaque('account-capacity', [launch.accountRevision, quota]),
    ...(plan && plan.length <= 40 ? { plan } : {}),
    observedAt: reading.observedAt,
    validUntil,
    windows,
  };
}

export interface RoutingExecutionBindingProof {
  catId: string;
  accountRevision?: string;
  providerId?: string;
}

/** One physical account-store snapshot per catalog read; no F293 writer or extra ledger. */
export function readAccountRoutingCapacity(input: {
  projectRoot: string;
  configs: Record<string, CatConfig>;
  observedAt: number;
  executionBindings?: readonly RoutingExecutionBindingProof[];
}): Map<string, Pick<RoutingCandidateBindingV1, 'provenQuotaPools' | 'capacityFacts'>> {
  const store = readAccountStoreSnapshot(input.projectRoot);
  const accounts = new Map<
    string,
    { clientId?: string; principalPinned?: boolean; capacity: RoutingAccountCapacityV1 }
  >();
  for (const ref of [...store.refs].sort()) {
    try {
      const entry = store.resolve(ref);
      if (entry.account)
        accounts.set(ref, {
          clientId: entry.account.clientId,
          principalPinned: Boolean(entry.account.codex?.identity),
          capacity: projectAccount(ref, entry.account, input.projectRoot, input.observedAt),
        });
    } catch {
      // Ref-specific rejection is isolated. No store exception text/private identity enters routing truth.
      accounts.set(ref, { capacity: unknown('account_unavailable') });
    }
  }
  return new Map(
    Object.entries(input.configs).map(([catId, config]) => {
      const configuredRef = usesNativeToolConfiguration(config)
        ? undefined
        : resolveBoundAccountRefForCat(input.projectRoot, catId, config);
      const execution = input.executionBindings?.find((proof) => proof.catId === catId);
      const frozen = execution?.accountRevision
        ? [...accounts.entries()].find(([, entry]) => entry.capacity.bindingRevision === execution.accountRevision)
        : undefined;
      const ref = frozen?.[0] ?? configuredRef;
      const bound = ref ? accounts.get(ref) : undefined;
      const providerId = execution?.providerId ?? (config.provider?.trim() || config.clientId);
      let current =
        bound?.clientId === providerId ? bound.capacity : unknown(ref ? 'account_unavailable' : 'binding_unknown');
      if (
        execution &&
        current.state !== 'unknown' &&
        // Legacy native launch revisions contain paths, not principal identity. They cannot prove C's quota.
        (!bound?.principalPinned || !execution.accountRevision || current.bindingRevision !== execution.accountRevision)
      )
        current = unknown('execution_binding_changed');
      const switchRequired = [...accounts.entries()]
        .filter(
          ([otherRef, account]) =>
            otherRef !== ref && account.clientId === providerId && account.capacity.state !== 'unknown',
        )
        .slice(0, 8)
        .map(([, account]) => account.capacity);
      return [
        catId,
        {
          // Even codex-main is only an account observation. No current producer proves
          // the provider-issued limitId consumed by this exact frozen execution.
          provenQuotaPools: [],
          capacityFacts: { v: 1 as const, current, switchRequired },
        },
      ];
    }),
  );
}
