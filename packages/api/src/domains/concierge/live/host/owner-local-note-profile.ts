import {
  createLocalNoteTrialProfile,
  type LocalNoteAction,
  type LocalNoteTrialPlan,
  prepareLocalNoteRollback,
  prepareLocalNoteTrial,
  selectLocalNoteAction,
} from '../../action/LocalNoteTrialProfile.js';
import type { OwnerPageActionProfile } from './owner-page-action-contract.js';

/** Adapt F's reviewed named page policy to A's owner consent lifecycle. */
export function createOwnerLocalNoteProfile(trustedFixtureUrl: string): OwnerPageActionProfile {
  const named = createLocalNoteTrialProfile(trustedFixtureUrl);
  return {
    profileId: named.profileId,
    url: named.url,
    spec: named.spec,
    prepare: (snapshot) => prepareLocalNoteTrial(named.url, snapshot),
    rollback(plan, result, snapshot) {
      if (plan.profileId !== named.profileId || plan.url !== named.url || plan.action.targetId !== named.targetId)
        throw new Error('Local trial plan changed');
      return prepareLocalNoteRollback(plan as LocalNoteTrialPlan, result, snapshot);
    },
    selector(action) {
      if (action.targetId !== named.targetId || action.operation !== 'fill')
        throw new Error('Local trial action changed');
      return selectLocalNoteAction(action as LocalNoteAction);
    },
  };
}
