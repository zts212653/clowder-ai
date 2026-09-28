import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { type CollectiveSourceIdentity, collectiveTargetSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
import type { ConnectorOutboxItem } from './state.js';
import { type VerifiedAgent, verifiedAgentSchema } from './state.js';

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
}

export async function prepareReplyOperation(input: PrepareReplyInput): Promise<ConnectorOutboxItem> {
  const operationKey = JSON.stringify([input.sourceRef, input.source.catId, input.resultKey]);
  if (!input.sourceRef.startsWith('message:') || input.sourceRef.length > 300 || operationKey.length > 1000) {
    throw participationError('RETURN_UNAVAILABLE', 'Invalid durable reply purpose');
  }
  return input.persistence.transaction((state) => {
    requireParticipation(state, input.source);
    const connection = state.connections[input.source.connectionId]!;
    const existing = connection.outbox.find((item) => item.operationKey === operationKey);
    if (existing) {
      if (!isDeepStrictEqual(existing.replySource, input.source))
        throw participationError('PARTICIPATION_REVOKED', 'A new grant cannot revive an old reply');
      return structuredClone(existing);
    }
    const root = input.source.location.rootEventId ?? input.source.eventId;
    const workPurpose = input.resultKey.startsWith('work:')
      ? {
          taskRef: `task:${input.resultKey}`,
          admittedRevision: z.number().int().positive().parse(input.workRevision),
          resultRevision: 1 as const,
        }
      : undefined;
    const item: ConnectorOutboxItem = {
      outboxId: `outbox_${randomUUID().replaceAll('-', '')}`,
      clientEventId: `reply_${randomUUID().replaceAll('-', '')}`,
      operationKey,
      sourceRef: input.sourceRef,
      replySource: structuredClone(input.source),
      ...(workPurpose ? { workPurpose } : {}),
      target: { kind: 'message', eventId: root },
      location: { channelId: input.source.location.channelId, rootEventId: root },
      replyToEventId: input.source.eventId,
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
  },
): Promise<ConnectorOutboxItem> {
  const body = z.string().trim().min(1).max(32000).parse(input.body);
  const agent = verifiedAgentSchema.parse(input.agent);
  if (agent.catId !== input.source.catId || agent.agentId !== input.source.catId || !(await input.verifyAgent(agent))) {
    throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Host could not verify the current Cat invocation');
  }
  return input.persistence.transaction((state) => {
    const { binding } = requireParticipation(state, input.source);
    if (binding.participation?.displayName !== agent.displayName)
      throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Named participant has changed');
    const item = state.connections[input.source.connectionId]!.outbox.find(
      (candidate) => candidate.outboxId === input.operationId,
    );
    if (
      !item ||
      item.operationKey !== JSON.stringify([input.sourceRef, input.source.catId, input.resultKey]) ||
      !isDeepStrictEqual(item.replySource, input.source)
    )
      throw participationError('RETURN_UNAVAILABLE', 'Reply operation does not belong to this source');
    if (item.status !== 'prepared') {
      if (item.body !== body || item.agent?.catId !== agent.catId || item.agent.displayName !== agent.displayName) {
        throw participationError('REPLY_PAYLOAD_CONFLICT', 'This reply operation already owns a different payload');
      }
      return structuredClone(item);
    }
    item.agent = agent;
    item.body = body;
    item.status = 'queued';
    return structuredClone(item);
  });
}
