import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { IMessageStore, QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import { resolveRestartExecutionWitness } from './QueuedMessageCustodyRestartWitness.js';
import {
  type QueueSourceResponseEvidence,
  resolveQueueSourceResponseEvidenceFromMessages,
} from './queue-source-response-evidence.js';

export interface RestartTargetProjection {
  pending: Set<string>;
  handled: Set<string>;
  failed: Set<string>;
  notified: Set<string>;
  awakenedInvocationIdByCatId: Record<string, string>;
  awakenedAtByCatId: Record<string, number>;
  seenInvocationIdByCatId: Record<string, string>;
  targetOutcomeByCatId: NonNullable<QueuedMessageCustody['targetOutcomeByCatId']>;
  handledTargets: number;
  failedTargets: number;
  interrupted: Set<string>;
  live: Set<string>;
}

interface RestartSourceResponse {
  exposure: NonNullable<QueuedMessageCustody['bodyExposures']>[number];
  witness: QueueSourceResponseEvidence['witness'];
}

function resolveRestartSourceResponse(
  message: StoredMessage,
  current: QueuedMessageCustody,
  catId: string,
  threadMessages: readonly StoredMessage[],
): RestartSourceResponse | null {
  const exposures = [...(current.bodyExposures ?? [])]
    .filter((candidate) => candidate.targetCatId === catId)
    .sort((left, right) => right.seenAt - left.seenAt);
  for (const exposure of exposures) {
    const sourceResponse = resolveQueueSourceResponseEvidenceFromMessages({
      messages: threadMessages,
      catId,
      invocationId: exposure.invocationId,
      sourceMessageIds: [message.id],
    })[0];
    if (sourceResponse) return { exposure, witness: sourceResponse.witness };
  }
  return null;
}

function interruptAcceptedTarget(projection: RestartTargetProjection, catId: string): void {
  if (!projection.pending.delete(catId)) return;
  if (!projection.failed.has(catId)) projection.failedTargets += 1;
  projection.failed.add(catId);
  projection.interrupted.add(catId);
  projection.notified.delete(catId);
  delete projection.awakenedInvocationIdByCatId[catId];
  delete projection.awakenedAtByCatId[catId];
  delete projection.seenInvocationIdByCatId[catId];
}

function completeTarget(
  projection: RestartTargetProjection,
  catId: string,
  invocationId?: string,
  exposure?: NonNullable<QueuedMessageCustody['bodyExposures']>[number],
  now?: number,
): void {
  projection.pending.delete(catId);
  projection.handled.add(catId);
  projection.failed.delete(catId);
  projection.notified.delete(catId);
  delete projection.awakenedInvocationIdByCatId[catId];
  delete projection.awakenedAtByCatId[catId];
  delete projection.seenInvocationIdByCatId[catId];
  if (invocationId && exposure && now !== undefined) {
    projection.targetOutcomeByCatId[catId] = {
      invocationId,
      disposition: 'completed_with_turn',
      evidenceRef: { kind: 'invocation_lineage', invocationId },
      handledAt: Math.max(now, exposure.seenAt + 1),
    };
  }
  projection.handledTargets += 1;
}

export async function resolveRestartTargets(
  message: StoredMessage,
  current: QueuedMessageCustody,
  messageStore: IMessageStore,
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
  turnExecutionStore: Pick<ITurnExecutionStore, 'get'> | undefined,
  replacedA2ATargetCats: ReadonlySet<string>,
  now: number,
): Promise<RestartTargetProjection> {
  const projection: RestartTargetProjection = {
    pending: new Set<string>(current.pendingTargetCats),
    handled: new Set<string>(current.handledByCatIds),
    failed: new Set<string>(current.failedByCatIds),
    notified: new Set<string>(current.notifiedByCatIds),
    awakenedInvocationIdByCatId: { ...(current.awakenedInvocationIdByCatId ?? {}) },
    awakenedAtByCatId: { ...(current.awakenedAtByCatId ?? {}) },
    seenInvocationIdByCatId: { ...current.seenInvocationIdByCatId },
    targetOutcomeByCatId: { ...(current.targetOutcomeByCatId ?? {}) },
    handledTargets: 0,
    failedTargets: 0,
    interrupted: new Set<string>(),
    live: new Set<string>(),
  };
  const retainedExposureTargets = new Set(
    (current.bodyExposures ?? [])
      .filter((exposure) => projection.pending.has(exposure.targetCatId))
      .map((exposure) => exposure.targetCatId),
  );
  let threadMessages: readonly StoredMessage[] = [];
  if (retainedExposureTargets.size > 0) {
    const readThread = messageStore.getByThreadAfter?.bind(messageStore);
    if (readThread) {
      // Exact cat/invocation/causal fences below own authority; source userId
      // must not hide scheduler-authored managed-command rows.
      threadMessages = await readThread(message.threadId);
    }
  }

  // Append-only body exposures can prove a source response even after active
  // seen maps were cleared by failed bookkeeping.
  for (const catId of [...projection.pending]) {
    if (replacedA2ATargetCats.has(catId) || !retainedExposureTargets.has(catId)) continue;
    const sourceResponse = resolveRestartSourceResponse(message, current, catId, threadMessages);
    if (!sourceResponse) continue;
    const { exposure, witness } = sourceResponse;
    completeTarget(projection, catId);
    projection.targetOutcomeByCatId[catId] = {
      invocationId: exposure.invocationId,
      disposition: 'responded',
      evidenceRef: { kind: 'invocation_lineage', invocationId: exposure.invocationId },
      handledAt: Math.max(now, exposure.seenAt + 1),
      consumption: witness,
    };
  }

  for (const [catId, invocationId] of Object.entries(current.seenInvocationIdByCatId)) {
    if (replacedA2ATargetCats.has(catId) || !projection.pending.has(catId)) continue;
    const exposure = current.bodyExposures?.find(
      (candidate) => candidate.targetCatId === catId && candidate.invocationId === invocationId,
    );
    const witness = await resolveRestartExecutionWitness(
      message,
      catId,
      invocationId,
      exposure !== undefined,
      invocationRecordStore,
      turnExecutionStore,
    );
    if (witness === 'child_execution' || witness === 'legacy_parent_aggregate') {
      completeTarget(projection, catId, witness === 'child_execution' ? invocationId : undefined, exposure, now);
    } else if (witness === 'live_child') {
      projection.live.add(catId);
    } else if (witness === 'interrupted_child') {
      interruptAcceptedTarget(projection, catId);
    } else if (
      witness === null &&
      (exposure !== undefined || current.awakenedInvocationIdByCatId?.[catId] === invocationId)
    ) {
      // Custody is the accepted-before-result witness. Missing exact child
      // truth must interrupt, never replay unknown provider effects.
      interruptAcceptedTarget(projection, catId);
    } else {
      delete projection.seenInvocationIdByCatId[catId];
      projection.failed.add(catId);
      projection.failedTargets += 1;
    }
  }

  for (const catId of Object.keys(current.awakenedInvocationIdByCatId ?? {})) {
    if (replacedA2ATargetCats.has(catId)) continue;
    if (current.seenInvocationIdByCatId[catId] || !projection.pending.has(catId)) continue;
    const invocationId = current.awakenedInvocationIdByCatId?.[catId];
    const witness = invocationId
      ? await resolveRestartExecutionWitness(
          message,
          catId,
          invocationId,
          false,
          invocationRecordStore,
          turnExecutionStore,
        )
      : null;
    if (witness === 'live_child') projection.live.add(catId);
    else if (witness === 'interrupted_child' || witness === null) interruptAcceptedTarget(projection, catId);
    else if (witness === 'child_execution' || witness === 'legacy_parent_aggregate') {
      completeTarget(projection, catId);
    } else {
      if (!projection.failed.has(catId)) projection.failedTargets += 1;
      projection.failed.add(catId);
    }
  }
  return projection;
}
