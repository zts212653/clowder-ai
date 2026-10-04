import { type CollectiveConnector } from '@cat-cafe/collective-connector';
import { type CollectiveAcceptedWorkResult, collectiveAcceptedWorkResultSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CollectiveWorkResultReconciler } from '../domains/plugin/builtin-runtime/collective-work-result-reconciler.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

interface CollectiveWorkResultRouteOptions {
  readonly connector: () => CollectiveConnector | undefined;
  readonly reconciler: CollectiveWorkResultReconciler;
}

interface AcceptedRequest {
  readonly Params: { readonly connectionId: string };
  readonly Body: unknown;
}

export function registerCollectiveWorkResultRoutes(app: FastifyInstance, options: CollectiveWorkResultRouteOptions) {
  const mutationTails = new Map<string, Promise<void>>();
  app.post<AcceptedRequest>(
    '/api/plugins/collective-connector/:connectionId/work/result/accepted',
    async (request, reply) => {
      const previous = mutationTails.get(request.params.connectionId) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      mutationTails.set(request.params.connectionId, tail);
      await previous;
      try {
        return await reconcileAcceptedResult(request, reply, options);
      } finally {
        release();
        if (mutationTails.get(request.params.connectionId) === tail) mutationTails.delete(request.params.connectionId);
      }
    },
  );
}

async function reconcileAcceptedResult(
  request: FastifyRequest<AcceptedRequest>,
  reply: FastifyReply,
  options: CollectiveWorkResultRouteOptions,
) {
  try {
    return await performAcceptedResultReconciliation(request, reply, options);
  } catch (error) {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_COLLECTIVE_RESULT' });
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'COLLECTIVE_RESULT_RECONCILE_FAILED';
    return reply
      .code(code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : 409)
      .send({ code, error: error instanceof Error ? error.message : 'Collective result could not be reconciled' });
  }
}

async function performAcceptedResultReconciliation(
  request: FastifyRequest<AcceptedRequest>,
  reply: FastifyReply,
  options: CollectiveWorkResultRouteOptions,
) {
  const access = requirePluginOwnerLocalAccess(request, 'write');
  if ('error' in access) return reply.send(pluginAccessError(reply, access));
  const connector = options.connector();
  if (!connector) return reply.code(409).send({ code: 'CONNECTOR_INACTIVE' });
  const input = collectiveAcceptedWorkResultSchema.parse(request.body);
  if (input.connectionId !== request.params.connectionId) {
    return reply.code(409).send({ code: 'COLLECTIVE_RESULT_CONNECTION_MISMATCH' });
  }
  const result = await connector.withAssignedWorkAuthority(
    request.params.connectionId,
    input.workId,
    async ({ connection, hostRoute, inbox, work }) => {
      if (hostRoute?.localOwnerUserId !== access.operator) {
        throw Object.assign(new Error('Collective Connector belongs to another local owner'), {
          code: 'CONNECTOR_OWNER_MISMATCH',
        });
      }
      if (!connectionMatches(input, connection)) {
        throw Object.assign(new Error('Collective result belongs to another connection'), {
          code: 'COLLECTIVE_RESULT_CONNECTION_MISMATCH',
        });
      }
      if (!acceptedWorkMatches(input, work, connection)) {
        throw Object.assign(new Error('Collective result is no longer current'), {
          code: 'COLLECTIVE_RESULT_NOT_CURRENT',
        });
      }
      const assignment = work.assignment;
      if (!assignment) {
        throw Object.assign(new Error('Collective Work has no current assignment'), {
          code: 'COLLECTIVE_RESULT_NOT_CURRENT',
        });
      }
      const sources = inbox.filter((item) => inboxSourceMatches(item, input, connection, assignment.catId));
      if (sources.length !== 1 || sources[0]?.routeReceipt?.kind !== 'thread_message') {
        throw Object.assign(new Error('Collective Work has no unique local source'), {
          code: 'COLLECTIVE_RESULT_SOURCE_UNAVAILABLE',
        });
      }
      return options.reconciler.reconcile({
        ownerUserId: access.operator,
        sourceMessageId: sources[0].routeReceipt.messageId,
        work,
      });
    },
  );
  if (result.result === 'not_admitted') {
    return reply.code(202).send(result);
  }
  if (result.result === 'terminal_unchanged') {
    return reply.code(409).send({ code: 'COLLECTIVE_RESULT_TERMINAL_CONFLICT', ...result });
  }
  return reply.send(result);
}

type Connection = Awaited<ReturnType<CollectiveConnector['getProjection']>>;
type Work = Awaited<ReturnType<CollectiveConnector['readAssignedWork']>>;
type InboxItem = Awaited<ReturnType<CollectiveConnector['listInbox']>>[number];

function connectionMatches(input: CollectiveAcceptedWorkResult, connection: Connection) {
  return (
    connection.authorityStatus === 'connected' &&
    connection.authorizedHumanId !== undefined &&
    input.serviceInstanceId === connection.serviceInstanceId &&
    input.collectiveId === connection.collectiveId
  );
}

function acceptedWorkMatches(input: CollectiveAcceptedWorkResult, work: Work, connection: Connection) {
  const assignment = work.assignment;
  return Boolean(
    assignment &&
      connection.authorizedHumanId &&
      work.revision === input.workRevision &&
      work.assignmentEventId === input.assignmentEventId &&
      work.resultEventId === input.resultEventId &&
      (work.resultRevision ?? 1) === input.resultRevision &&
      work.lifecycle === 'completed' &&
      work.status === 'completed' &&
      work.history.some(
        (entry) =>
          entry.action === 'result_accepted' &&
          entry.eventId === input.resultEventId &&
          (entry.resultRevision ?? 1) === input.resultRevision,
      ) &&
      assignment.connectionId === connection.connectionId &&
      assignment.humanId === connection.authorizedHumanId &&
      work.accountableHumanId === connection.authorizedHumanId,
  );
}

function inboxSourceMatches(
  item: InboxItem,
  input: CollectiveAcceptedWorkResult,
  connection: Connection,
  catId: string,
) {
  const recipient = item.event.recipient;
  return (
    item.event.eventId === input.assignmentEventId &&
    item.event.serviceInstanceId === input.serviceInstanceId &&
    item.event.collectiveId === input.collectiveId &&
    item.event.workRequest === 'entrust' &&
    item.disposition === 'routed' &&
    item.routeReceipt?.kind === 'thread_message' &&
    recipient?.kind === 'agent' &&
    recipient.connectionId === connection.connectionId &&
    recipient.humanId === connection.authorizedHumanId &&
    recipient.agentId === catId
  );
}
