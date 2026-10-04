import type {
  CollectiveAgentMessageRequest,
  CollectiveWorkProgressReceipt,
  CollectiveWorkResultReceipt,
} from '@cat-cafe/shared';
import { issueCollectiveWorkResultReceipt } from './collaboration-work.js';
import { issueCollectiveWorkProgressReceipt } from './collaboration-work-progress.js';
import { CollectiveServiceError } from './errors.js';
import { resolveEventAddress } from './event-location.js';
import { requireParticipant, sourceAuthorizesParticipant } from './participation-store.js';
import type { ConnectionRecord, MutableServiceState } from './state.js';

export function requireAgentMessageParticipation(
  state: MutableServiceState,
  input: CollectiveAgentMessageRequest,
  connection: ConnectionRecord,
  authorizedHumanId: string,
  now: number,
): {
  authoritativeDisplayName?: string;
  workResultReceipt?: CollectiveWorkResultReceipt;
  workProgressReceipt?: CollectiveWorkProgressReceipt;
} {
  if ((input.workResultIntent || input.workProgressIntent) && input.participationRevision === undefined) {
    throw new CollectiveServiceError(
      'RETURN_UNAVAILABLE',
      'Work result requires the current exact participation source',
      409,
    );
  }
  if (input.participationRevision === undefined) return {};
  const address = resolveEventAddress(state.events[input.collectiveId] ?? [], input);
  const participant = requireParticipant(state, {
    ...input,
    catId: input.agent.catId,
    humanId: authorizedHumanId,
    channelId: address.location.channelId,
    participationRevision: input.participationRevision,
  });
  const receipt = issueCollectiveWorkResultReceipt(
    state,
    input,
    {
      connectionId: connection.connectionId,
      humanId: authorizedHumanId,
      catId: input.agent.catId,
    },
    now,
  );
  const progressReceipt = issueCollectiveWorkProgressReceipt(
    state,
    input,
    { connectionId: connection.connectionId, humanId: authorizedHumanId, catId: input.agent.catId },
    now,
  );
  const authorityReceipt = receipt ?? progressReceipt;
  // The result address remains the first assignment. Permission comes from the
  // verified current execution, never from reviving that historical public source.
  const work = authorityReceipt ? state.works[authorityReceipt.workId] : undefined;
  const authorityEventId = authorityReceipt
    ? (work?.executionAuthority?.eventId ?? work?.assignmentEventId)
    : undefined;
  const source = (state.events[input.collectiveId] ?? []).find(
    (event) => event.eventId === (authorityEventId ?? input.replyToEventId),
  );
  const sourceCatId = authorityReceipt?.assignmentCatId ?? input.agent.catId;
  if (sourceCatId !== input.agent.catId) {
    requireParticipant(state, {
      ...input,
      catId: sourceCatId,
      humanId: authorizedHumanId,
      channelId: address.location.channelId,
      participationRevision: input.participationRevision,
    });
  }
  if (
    input.agent.agentId !== input.agent.catId ||
    !source ||
    !sourceAuthorizesParticipant(source, {
      connectionId: connection.connectionId,
      catId: sourceCatId,
      participationRevision: input.participationRevision,
      humanId: authorizedHumanId,
    }) ||
    address.recipient.kind !== 'channel'
  ) {
    throw new CollectiveServiceError(
      'PARTICIPATION_REVOKED',
      'Reply is not bound to the current participant source',
      403,
    );
  }
  return {
    authoritativeDisplayName: participant.displayName,
    workResultReceipt: receipt,
    workProgressReceipt: progressReceipt,
  };
}
