import { randomUUID } from 'node:crypto';

import { collectiveTargetSchema } from '@cat-cafe/shared';
import { z } from 'zod';

import type { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
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
