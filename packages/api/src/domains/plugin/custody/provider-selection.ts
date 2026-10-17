import type { TerminalPredicateProviderContribution } from '@clowder-ai/plugin-contract';
import type { ActionTerminalProviderBinding } from '../../ball-custody/action-terminal-provider-binding.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInstanceRecord, PluginInventorySnapshot, PluginPackageRecord } from '../host-inventory/types.js';

export interface PredicateInstallationScope {
  readonly tenantScope: string;
  readonly installationProjectRoot: string;
}
export interface AuthorizedPredicateProvider {
  readonly binding: ActionTerminalProviderBinding;
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
}

export function refusePredicateAuthority(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}

/** Availability is deliberately not a selector. A disabled authorized competitor
 * still makes new admission ambiguous; existing leases only use their frozen binding. */
export function authorizedPredicateProviders(
  snapshot: Pick<PluginInventorySnapshot, 'instances' | 'packages' | 'grants'>,
  scope: PredicateInstallationScope,
): AuthorizedPredicateProvider[] {
  const matches: AuthorizedPredicateProvider[] = [];
  for (const instance of snapshot.instances) {
    if (instance.lifecycleState !== 'installed') continue;
    const packageRecord = snapshot.packages.find((p) => p.packageDigest === instance.packageDigest);
    const grant = snapshot.grants.find((g) => g.pluginInstanceId === instance.pluginInstanceId);
    if (!packageRecord || packageRecord.packageState !== 'installed' || !grant) continue;
    if (packageRecord.pluginId !== instance.pluginId) refusePredicateAuthority('Provider package identity mismatch');
    for (const contribution of packageRecord.manifest.contributions ?? []) {
      if (!isReviewProvider(contribution)) continue;
      const owners = packageRecord.manifest.features.filter((feature) =>
        feature.contributions?.some((ref) => ref.type === contribution.type && ref.id === contribution.id),
      );
      const owner = owners[0];
      if (owners.length !== 1 || !owner?.capabilities.includes('custody.verify'))
        refusePredicateAuthority('Provider feature owner is invalid');
      if (!owner.capabilities.every((capability) => grant.effectiveGrants.includes(capability))) continue;
      matches.push({
        instance,
        packageRecord,
        binding: Object.freeze({
          pluginInstanceId: instance.pluginInstanceId,
          packageDigest: instance.packageDigest,
          featureId: owner.id,
          contributionId: contribution.id,
          freshnessMethod: contribution.freshnessMethod,
          completionMethod: contribution.completionMethod,
          grantRevision: grant.grantRevision,
          lifecycleRevision: instance.lifecycleRevision,
          ...scope,
        }),
      });
    }
  }
  return matches;
}

function isReviewProvider(value: { type: string }): value is TerminalPredicateProviderContribution {
  if (value.type !== 'terminal-predicate-provider') return false;
  const contribution = value as TerminalPredicateProviderContribution;
  return (
    contribution.actionFamily === 'review' &&
    contribution.predicateKind === 'review_delivered' &&
    contribution.subjectNamespace === 'pr'
  );
}

export function assertPredicateProviderRunnable(provider: AuthorizedPredicateProvider): void {
  if (
    provider.packageRecord.manifest.runtime?.transport !== 'builtin' ||
    provider.instance.activationState !== 'enabled' ||
    provider.instance.configReadiness !== 'ready' ||
    provider.instance.runtimeState !== 'healthy'
  )
    refusePredicateAuthority('Bound predicate provider is not runnable');
}
