import type { CatId } from '@cat-cafe/shared';
import { type DossierEngagementPolicy, loadDossierProfiles } from '@cat-cafe/shared/dossier';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';

export type EngagementPolicyReader = (catId: string) => DossierEngagementPolicy | undefined;

/** Read the applied dossier at the send boundary; never infer scarcity from breed/model. */
export const readEngagementPolicy: EngagementPolicyReader = (catId) =>
  loadDossierProfiles(resolveActiveProjectRoot()).get(catId)?.engagementPolicy;

export function partitionNotificationTargets(
  input: {
    targets: readonly CatId[];
    effectClass?: string | undefined;
    coordinationPhase?: string | undefined;
    substantiveAction?: boolean | undefined;
  },
  getPolicy: EngagementPolicyReader,
): { wakeTargets: CatId[]; deliveredWithoutWake: CatId[] } {
  const notification =
    !input.substantiveAction &&
    input.effectClass !== 'assign_work' &&
    input.coordinationPhase !== 'active' &&
    (input.effectClass === 'fyi' || input.coordinationPhase === 'terminal');
  const deliveredWithoutWake = notification
    ? input.targets.filter((catId) => getPolicy(catId)?.quota === 'weekly_subscription_scarce')
    : [];
  const quiet = new Set(deliveredWithoutWake);
  return { wakeTargets: input.targets.filter((catId) => !quiet.has(catId)), deliveredWithoutWake };
}

export function notificationDeliveryReceipt(catIds: readonly string[] | undefined) {
  return catIds && catIds.length > 0
    ? {
        deliveredWithoutWake: [...catIds],
        message: `已送达，未叫醒：${catIds.map((catId) => `@${catId}`).join('、')}；保留未读，尚未确认已读。`,
      }
    : {};
}
