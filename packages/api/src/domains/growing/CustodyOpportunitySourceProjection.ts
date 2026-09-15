import {
  type CustodyOfferV1,
  type CustodyOpportunityEpisodeInputV1,
  custodyOfferV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import { deriveGrowingSourceMessageRevision, type StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence, isSystemUserMessage } from '../cats/services/stores/visibility.js';
import {
  CUSTODY_OUTCOME_DELAY_MS,
  CUSTODY_SILENCE_DELAY_MS,
  type CustodyOpportunityCohort,
  custodyOpportunitySample,
} from './CustodyOpportunityCohortStore.js';
import { containsEntrustedWorkTimeSignal } from './EntrustedWorkSourceSignals.js';

type Episode = CustodyOpportunityEpisodeInputV1;
export type OpportunityProjection =
  | { kind: 'episode'; episode: Episode }
  | { kind: 'excluded' }
  | { kind: 'gap'; sourceRef: string; reason: string };

export function projectCustodyOpportunity(
  source: StoredMessage,
  tasks: readonly TaskItem[],
  cohort: CustodyOpportunityCohort,
  capturedAt: number,
): OpportunityProjection {
  const sourceRef = `message:${source.id}`;
  const gap = (reason: string): OpportunityProjection => ({ kind: 'gap', sourceRef, reason });
  if (!belongsToProspectiveCohort(source, cohort)) return { kind: 'excluded' };
  if (source.recall || source._tombstone || source.deletedAt !== undefined || !isDurableOwnerReadEvidence(source)) {
    return gap('source_unavailable');
  }
  const sourceRevision = deriveGrowingSourceMessageRevision(source);
  const matchingTasks = tasks.filter(
    (task) =>
      task.userId === source.userId &&
      task.threadId === source.threadId &&
      task.entrustedWork?.admission.sourceRefs.includes(sourceRef),
  );
  if (matchingTasks.length > 1) return gap('multiple_source_linked_outcomes');
  const task = matchingTasks[0];
  const work = task?.entrustedWork;
  const rawOffer = source.extra?.custodyOfferV1;
  const parsedOffer = rawOffer === undefined ? null : custodyOfferV1Schema.safeParse(rawOffer);
  if (source.custodyOfferParseFailure || (parsedOffer && !parsedOffer.success)) return gap('offer_unreadable');
  const offer = parsedOffer?.success ? parsedOffer.data : undefined;
  if (offer && (offer.sourceMessageRevision !== sourceRevision || offer.policyVersion !== 'custody-recognition-v1')) {
    return gap('source_or_policy_changed');
  }
  if (task && task.updatedAt > capturedAt) return gap('owner_changed_during_snapshot');
  if (!offer && work?.admission.basis === 'accepted_offer') return gap('accepted_offer_unavailable');
  const exposedAt = offer ? offer.recognizedAt : work?.admission.admittedAt;
  if ((offer || work) && (exposedAt === undefined || exposedAt < source.timestamp || exposedAt > capturedAt)) {
    return gap('candidate_exposure_unverified');
  }
  const action = offer !== undefined || work !== undefined;
  const sampled = custodyOpportunitySample(sourceRef, cohort.policyVersion);
  const riskTargeted = containsEntrustedWorkTimeSignal(source.content);
  if (!action && ((!sampled && !riskTargeted) || capturedAt - source.timestamp < CUSTODY_SILENCE_DELAY_MS)) {
    return { kind: 'excluded' };
  }
  const policyDisposition = offer ? 'offer' : work ? 'auto_admit' : 'uninformed_silence';
  return {
    kind: 'episode',
    episode: {
      version: 1,
      ownerRef: `user:${cohort.ownerUserId}`,
      policyVersion: cohort.policyVersion,
      source: { subjectRef: sourceRef, sourceRevision, evidenceRefs: [sourceRef] },
      window: action
        ? { kind: 'action', openedAt: source.timestamp, closedAt: capturedAt }
        : {
            kind: 'sampled_silent',
            openedAt: source.timestamp,
            closedAt: capturedAt,
            sampling: {
              bucket: sampled ? 'random' : 'risk_targeted',
              sampleRef: `${cohort.cohortRef}#sample:${source.id}`,
              policyVersion: cohort.samplingPolicy,
            },
          },
      candidate:
        action && exposedAt !== undefined
          ? {
              state: 'exposed',
              exposedAt,
              reasonCode: offer ? offer.reasonCode : work ? work.admission.basis : 'unverified',
            }
          : { state: 'not_exposed' },
      policyDisposition,
      userDisposition: readHumanDisposition(source, offer, capturedAt),
      custody: readTaskCustody(task),
      opportunityAssessment: { state: 'unknown' },
      delayedOutcome: readDelayedOutcome(source, work, capturedAt),
      interruption: { state: 'none_observed' },
      duplicatePromptRefs: [],
    },
  };
}

function belongsToProspectiveCohort(source: StoredMessage, cohort: CustodyOpportunityCohort): boolean {
  return !(
    source.userId !== cohort.ownerUserId ||
    source.catId !== null ||
    isSystemUserMessage(source) ||
    source.source ||
    source.sourceParseFailure ||
    source.extra?.crossPost ||
    source.timestamp < cohort.startedAt ||
    source.timestamp > cohort.reviewAt
  );
}

function readHumanDisposition(
  source: StoredMessage,
  offer: CustodyOfferV1 | undefined,
  capturedAt: number,
): Episode['userDisposition'] {
  if (!offer) return { state: 'not_applicable' };
  if (
    offer.disposition === 'pending' ||
    offer.dispositionAt > capturedAt ||
    offer.actorRef !== `user:${source.userId}`
  ) {
    return { state: 'not_observed' };
  }
  const result = offer.disposition === 'accepted' ? 'accept' : offer.disposition === 'declined' ? 'decline' : 'dismiss';
  return {
    state: 'observed',
    result,
    dispositionRef: `message:${source.id}#custody:${offer.offerId}:${offer.disposition}:${offer.dispositionAt}`,
  };
}

function readTaskCustody(task: TaskItem | undefined): Episode['custody'] {
  const work = task?.entrustedWork;
  if (!task || !work) return { state: 'no_task' };
  return {
    state: 'admitted',
    taskRef: { subjectRef: `task:item:${task.id}`, observedRevision: work.revision },
    receiptRef: work.admission.receiptRef,
  };
}

function readDelayedOutcome(
  source: StoredMessage,
  work: TaskItem['entrustedWork'],
  capturedAt: number,
): Episode['delayedOutcome'] {
  if (work && work.closure.state !== 'open' && work.closure.evidenceRefs.length) {
    return { state: 'available', outcomeRefs: work.closure.evidenceRefs };
  }
  return capturedAt - source.timestamp >= CUSTODY_OUTCOME_DELAY_MS ? { state: 'missing' } : { state: 'pending' };
}
