import { createHash } from 'node:crypto';
import {
  claudeQuotaWindows,
  isClaudeSharedWindow,
  type RoutingAccountCapacityV1,
  type RoutingCapacityWindowV1,
} from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from './account-resolver.js';
import { readClaudeQuota } from './claude-quota-store.js';
import { claudeExecutionAccountSnapshot } from './claude-token-account.js';

const opaque = (prefix: string, value: unknown) =>
  `${prefix}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
type ObservedWindow = ReturnType<typeof claudeQuotaWindows>[number];
const hasQuantity = (window: ObservedWindow): window is ObservedWindow & { utilization: number } =>
  window.utilization !== undefined;

/** Account observations, just like Codex's main/Spark/review windows: never model eligibility or permission. */
export async function readClaudeRoutingAccount(profile: RuntimeProviderProfile, root: string, now: number) {
  const owner = await claudeExecutionAccountSnapshot(profile);
  const unknown = (reason: RoutingAccountCapacityV1['reason']): RoutingAccountCapacityV1 => ({
    state: 'unknown',
    reason,
    windows: [],
    bindingRevision: owner.accountRevision,
  });
  const project = (): RoutingAccountCapacityV1 => {
    if (!owner.credentialVersion) return unknown('principal_unverified');
    const quota = readClaudeQuota(root, profile.id, owner.credentialVersion);
    if (!quota) return unknown('observation_missing');
    const readings = claudeQuotaWindows(quota.samples);
    if (!readings.length || readings.length > 16 || !readings.every(hasQuantity)) return unknown('no_supported_pool');
    const windows: RoutingCapacityWindowV1[] = readings.map((window) => ({
      poolId: opaque('quota-pool', [
        owner.accountRef,
        owner.credentialVersion,
        window.key,
        isClaudeSharedWindow(window.key) ? '' : window.model,
      ]),
      poolKind: 'claude-subscription',
      windowKey: window.key,
      ...(!isClaudeSharedWindow(window.key) ? { observedModel: window.model } : {}),
      applicability: 'unknown',
      freshness:
        window.observedAt <= now &&
        now < window.observedAt + 600000 &&
        (window.resetsAt === undefined || now < window.resetsAt * 1000)
          ? 'fresh'
          : 'stale',
      kind: window.key === 'five_hour' ? 'five_hour' : window.key.startsWith('seven_day') ? 'seven_day' : 'unknown',
      remainingPercent: Math.round((1 - window.utilization) * 10000) / 100,
      ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt * 1000 }),
    }));
    const observedAt = Math.min(...readings.map((window) => window.observedAt));
    const elapsed = windows.some((window) => window.resetAt !== undefined && now >= window.resetAt);
    const fresh = windows.every((window) => window.freshness === 'fresh');
    const label = profile.displayName?.trim();
    return {
      state: fresh ? 'fresh' : 'stale',
      ...(!fresh ? { reason: elapsed ? ('reset_elapsed' as const) : ('observation_stale' as const) } : {}),
      ...(label && label.length <= 80 && !label.includes('@') && label !== profile.id ? { accountLabel: label } : {}),
      bindingRevision: owner.accountRevision,
      evidenceRef: opaque('account-capacity', [owner.accountRevision, quota]),
      observedAt,
      validUntil: observedAt + 600000,
      windows,
    };
  };
  return { owner, capacity: project() };
}
