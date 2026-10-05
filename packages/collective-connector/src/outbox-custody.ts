import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { type CollectiveSourceIdentity, collectiveTargetSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { participationError, requireParticipation, resolveMaterializedParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
import type { ConnectorOutboxItem, MutableConnectorState } from './state.js';
import {
  type VerifiedAgent,
  verifiedAgentSchema,
  type WorkResultArtifactSnapshot,
  workResultArtifactSnapshotSchema,
} from './state.js';

const queuedMessageSchema = z
  .object({
    clientEventId: z.string().trim().min(1).max(200),
    agent: verifiedAgentSchema,
    target: collectiveTargetSchema,
    replyToEventId: z.string().optional(),
    body: z.string().trim().min(1).max(32_000),
  })
  .strict();

export async function queueVerifiedAgentMessage(input: {
  persistence: ConnectorPersistence;
  verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
  now: () => number;
  connectionId: string;
  unsafeInput: unknown;
}): Promise<ConnectorProjection> {
  const message = queuedMessageSchema.parse(input.unsafeInput);
  if (!(await input.verifyAgent(message.agent))) {
    throw new Error('Host could not verify the Agent/session binding');
  }
  return input.persistence.transaction((state) => {
    const connection = state.connections[input.connectionId];
    if (!connection) throw new Error('Collective connection was not found');
    if (connection.authorityStatus !== 'connected' || !connection.endpointCredential) {
      throw new Error('Collective connection is not authorized');
    }
    const existing = connection.outbox.find((item) => item.clientEventId === message.clientEventId);
    if (existing) {
      const same =
        existing.body === message.body &&
        existing.replyToEventId === message.replyToEventId &&
        JSON.stringify(existing.target) === JSON.stringify(message.target) &&
        JSON.stringify(existing.agent) === JSON.stringify(message.agent);
      if (!same) throw new Error('clientEventId already names another outbound message');
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    }
    connection.outbox.push({
      outboxId: `outbox_${randomUUID().replaceAll('-', '')}`,
      clientEventId: message.clientEventId,
      agent: message.agent,
      target: message.target,
      ...(message.replyToEventId ? { replyToEventId: message.replyToEventId } : {}),
      body: message.body,
      status: 'queued',
      createdAt: new Date(input.now()).toISOString(),
    });
    return projectConnection(connection, state.hostRoutes[connection.connectionId]);
  });
}

interface PrepareReplyInput {
  persistence: ConnectorPersistence;
  now: () => number;
  source: CollectiveSourceIdentity;
  sourceRef: string;
  resultKey: string;
  workRevision?: number;
  resultRevision?: number;
  execution?: { readonly revision: number; readonly assignmentEventId: string };
  progressKey?: string;
}

type MutableOutboxItem = MutableConnectorState['connections'][string]['outbox'][number];

function replyOperationKeys(
  input: Pick<PrepareReplyInput, 'sourceRef' | 'source' | 'resultKey' | 'execution' | 'progressKey'>,
  resultRevision: number,
) {
  const legacyOperationKey = JSON.stringify([input.sourceRef, input.source.catId, input.resultKey]);
  return {
    workResult: input.resultKey.startsWith('work:'),
    legacyOperationKey,
    operationKey: input.progressKey
      ? JSON.stringify([
          'progress',
          input.sourceRef,
          input.source.catId,
          input.resultKey,
          resultRevision,
          input.execution?.revision,
          input.progressKey,
        ])
      : input.resultKey.startsWith('work:')
        ? JSON.stringify([
            input.sourceRef,
            input.source.catId,
            input.resultKey,
            resultRevision,
            ...(input.execution && input.execution.revision > 1 ? [input.execution.revision] : []),
          ])
        : legacyOperationKey,
  };
}

function isExistingReplyOperation(
  item: ConnectorOutboxItem,
  operationKey: string,
  legacyOperationKey: string,
  workResult: boolean,
  resultRevision: number,
): boolean {
  return (
    item.operationKey === operationKey ||
    (workResult &&
      resultRevision === 1 &&
      item.operationKey === legacyOperationKey &&
      item.workPurpose?.resultRevision === 1)
  );
}

function refreshPreparedWorkPurpose(
  item: MutableOutboxItem,
  workPurpose: MutableOutboxItem['workPurpose'],
  operationKey: string,
): void {
  if (item.status !== 'prepared' || !item.workPurpose || !workPurpose) return;
  item.workPurpose.admittedRevision = workPurpose.admittedRevision;
  item.operationKey = operationKey;
}

function requireReplyOperation(
  state: MutableConnectorState,
  input: PrepareReplyInput & { readonly operationId: string },
  agent: VerifiedAgent,
): MutableOutboxItem {
  const { binding, connection, route } = requireParticipation(state, input.source);
  const item = connection.outbox.find((candidate) => candidate.outboxId === input.operationId);
  const resultRevision = z
    .number()
    .int()
    .positive()
    .parse(input.resultRevision ?? 1);
  const { legacyOperationKey, operationKey, workResult } = replyOperationKeys(input, resultRevision);
  const operationMatches =
    item?.operationKey === operationKey ||
    (workResult && !input.progressKey && resultRevision === 1 && item?.operationKey === legacyOperationKey);
  if (
    !item ||
    !operationMatches ||
    item.workPurpose?.progressKey !== input.progressKey ||
    (workResult
      ? item.workPurpose?.resultRevision !== resultRevision ||
        (item.workPurpose.executionRevision ?? 1) !== (input.execution?.revision ?? 1) ||
        (item.workPurpose.assignmentEventId ?? input.source.eventId) !==
          (input.execution?.assignmentEventId ?? input.source.eventId)
      : item.workPurpose !== undefined) ||
    !isDeepStrictEqual(item.replySource, input.source)
  ) {
    throw participationError('RETURN_UNAVAILABLE', 'Reply operation does not belong to this source');
  }
  const executorBinding =
    agent.catId === input.source.catId
      ? binding
      : connection.authorizedHumanId
        ? resolveMaterializedParticipation(
            route,
            connection.authorizedHumanId,
            agent.catId,
            input.source.location.channelId,
          )
        : undefined;
  if ((agent.catId !== input.source.catId && !item.workPurpose) || executorBinding?.displayName !== agent.displayName) {
    throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Named participant has changed');
  }
  return item;
}

function assertArtifactMatchesWork(
  item: ConnectorOutboxItem,
  artifactSnapshot: WorkResultArtifactSnapshot | undefined,
): void {
  if (artifactSnapshot && !item.workPurpose) {
    throw participationError('RETURN_UNAVAILABLE', 'Prepared Artifact does not belong to an admitted Work result');
  }
  if (
    artifactSnapshot &&
    item.workPurpose &&
    (artifactSnapshot.taskRef !== item.workPurpose.taskRef ||
      artifactSnapshot.taskRevision !== item.workPurpose.admittedRevision)
  ) {
    throw participationError('RETURN_UNAVAILABLE', 'Prepared Artifact does not match the current Task revision');
  }
}

function recoverSubmittedReply(
  item: ConnectorOutboxItem,
  body: string,
  agent: VerifiedAgent,
  artifactSnapshot: WorkResultArtifactSnapshot | undefined,
): ConnectorOutboxItem | undefined {
  if (item.status === 'prepared') return undefined;
  if (
    item.body !== body ||
    item.agent?.catId !== agent.catId ||
    !isDeepStrictEqual(item.workPurpose?.artifactSnapshot, artifactSnapshot)
  ) {
    throw participationError('REPLY_PAYLOAD_CONFLICT', 'This reply operation already owns a different payload');
  }
  return structuredClone(item);
}

export async function prepareReplyOperation(input: PrepareReplyInput): Promise<ConnectorOutboxItem> {
  const resultRevision = z
    .number()
    .int()
    .positive()
    .parse(input.resultRevision ?? 1);
  const { legacyOperationKey, operationKey, workResult } = replyOperationKeys(input, resultRevision);
  if (!input.sourceRef.startsWith('message:') || input.sourceRef.length > 300 || operationKey.length > 1000) {
    throw participationError('RETURN_UNAVAILABLE', 'Invalid durable reply purpose');
  }
  return input.persistence.transaction((state) => {
    requireParticipation(state, input.source);
    const connection = state.connections[input.source.connectionId];
    if (!connection) throw participationError('PARTICIPATION_REVOKED', 'Collective connection is unavailable');
    const workPurpose = workResult
      ? {
          taskRef: `task:${input.resultKey}`,
          admittedRevision: z.number().int().positive().parse(input.workRevision),
          resultRevision,
          ...(input.execution
            ? { executionRevision: input.execution.revision, assignmentEventId: input.execution.assignmentEventId }
            : {}),
          ...(input.progressKey ? { progressKey: input.progressKey } : {}),
        }
      : undefined;
    const existing = connection.outbox.find((item) =>
      isExistingReplyOperation(
        item,
        operationKey,
        legacyOperationKey,
        workResult && !input.progressKey,
        resultRevision,
      ),
    );
    if (existing) {
      if (!isDeepStrictEqual(existing.replySource, input.source))
        throw participationError('PARTICIPATION_REVOKED', 'A new grant cannot revive an old reply');
      if ((existing.workPurpose?.executionRevision ?? 1) !== (input.execution?.revision ?? 1))
        throw participationError(
          'WORK_EXECUTION_NOT_CURRENT',
          'A new authority cannot retarget a prior reply operation',
        );
      refreshPreparedWorkPurpose(existing, workPurpose, operationKey);
      return structuredClone(existing);
    }
    const root = input.source.location.rootEventId ?? input.source.eventId;
    const item: ConnectorOutboxItem = {
      outboxId: `outbox_${randomUUID().replaceAll('-', '')}`,
      clientEventId: `reply_${randomUUID().replaceAll('-', '')}`,
      operationKey,
      sourceRef: input.sourceRef,
      replySource: structuredClone(input.source),
      ...(workPurpose ? { workPurpose } : {}),
      target: { kind: 'message', eventId: root },
      location: { channelId: input.source.location.channelId, rootEventId: root },
      replyToEventId: input.execution?.assignmentEventId ?? input.source.eventId,
      body: '',
      status: 'prepared',
      createdAt: new Date(input.now()).toISOString(),
    };
    connection.outbox.push(item);
    return structuredClone(item);
  });
}

export async function submitReplyOperation(
  input: PrepareReplyInput & {
    operationId: string;
    body: string;
    agent: VerifiedAgent;
    verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
    artifactSnapshot?: WorkResultArtifactSnapshot;
  },
): Promise<ConnectorOutboxItem> {
  const body = z.string().trim().min(1).max(32000).parse(input.body);
  const agent = verifiedAgentSchema.parse(input.agent);
  const artifactSnapshot = input.artifactSnapshot
    ? workResultArtifactSnapshotSchema.parse(input.artifactSnapshot)
    : undefined;
  if (agent.agentId !== agent.catId || !(await input.verifyAgent(agent))) {
    throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Host could not verify the current Cat invocation');
  }
  return input.persistence.transaction((state) => {
    const item = requireReplyOperation(state, input, agent);
    assertArtifactMatchesWork(item, artifactSnapshot);
    const recovered = recoverSubmittedReply(item, body, agent, artifactSnapshot);
    if (recovered) return recovered;
    item.agent = agent;
    item.body = body;
    if (item.workPurpose && artifactSnapshot) item.workPurpose.artifactSnapshot = artifactSnapshot;
    item.status = 'queued';
    return structuredClone(item);
  });
}
