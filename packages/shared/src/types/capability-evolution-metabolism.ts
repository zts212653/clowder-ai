import type { EvolutionProgramEventV1, EvolutionProgramV1 } from './capability-evolution.js';
import { type AssetVersionRefV1, assetOwnerIdentity, refIdentity } from './capability-evolution-refs.js';

type CurrentVersions = readonly EvolutionProgramV1['currentAssetVersionRefs'][number][];

function currentVersion(currentVersions: CurrentVersions, next: AssetVersionRefV1) {
  return currentVersions.find((candidate) => assetOwnerIdentity(candidate) === assetOwnerIdentity(next));
}

function interventionTransitionError(
  currentVersions: CurrentVersions,
  event: Extract<EvolutionProgramEventV1, { type: 'intervention_receipt_linked' }>,
): string | undefined {
  const current = currentVersion(currentVersions, event.assetVersionRef);
  if (!current) return `${event.result} intervention receipt belongs to an asset the Program does not track`;
  const unchanged = refIdentity(current) === refIdentity(event.assetVersionRef);
  if (event.result === 'no_change' && !unchanged) {
    return 'no_change intervention receipt must preserve the exact current asset version';
  }
  if (event.result === 'changed' && unchanged) {
    return 'changed intervention receipt must name a new exact asset version';
  }
  return undefined;
}

function decisionTransitionError(
  currentVersions: CurrentVersions,
  event: Extract<EvolutionProgramEventV1, { type: 'decision_recorded' }>,
): string | undefined {
  if ((event.decision !== 'rollback' && event.decision !== 'no_change') || event.assetVersionRef === undefined) {
    return undefined;
  }
  const current = currentVersion(currentVersions, event.assetVersionRef);
  if (!current) return `${event.decision} receipt belongs to an asset the Program does not track`;
  const unchanged = refIdentity(current) === refIdentity(event.assetVersionRef);
  if (event.decision === 'no_change' && !unchanged) {
    return 'no_change receipt must preserve the exact current asset version';
  }
  if (event.decision === 'rollback' && unchanged) {
    return 'rollback receipt must name a different exact version of the same asset';
  }
  return undefined;
}

export function metabolismAssetTransitionError(
  currentVersions: CurrentVersions,
  event: EvolutionProgramEventV1,
): string | undefined {
  if (event.type === 'intervention_receipt_linked') return interventionTransitionError(currentVersions, event);
  if (event.type === 'decision_recorded') return decisionTransitionError(currentVersions, event);
  return undefined;
}
