import { createHash, randomUUID } from 'node:crypto';
import { recordThreadProgressInputSchema, type ThreadProgressSourceRef } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type {
  AppendThreadProgressReceiptResult,
  IThreadProgressReceiptStore,
} from '../domains/thread-progress/ThreadProgressReceiptStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import type { CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';

export interface CallbackThreadProgressRouteDeps {
  readonly receiptStore: IThreadProgressReceiptStore;
  readonly threadStore: Pick<IThreadStore, 'get'>;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly taskStore?: Pick<ITaskStore, 'get'>;
  readonly socketManager?: Pick<SocketManager, 'broadcastToRoom'>;
  /** Standalone tests register their own auth hook; callbacksRoutes already owns one. */
  readonly registry?: CallbackAuthRegistry;
}

export function deriveThreadProgressSourceKey(input: {
  ownerUserId: string;
  threadId: string;
  canonicalTerminalSourceIdentity: string;
  kind: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.ownerUserId, input.threadId, input.canonicalTerminalSourceIdentity, input.kind]))
    .digest('hex');
}

export function registerCallbackThreadProgressRoutes(
  app: FastifyInstance,
  deps: CallbackThreadProgressRouteDeps,
): void {
  if (deps.registry) registerCallbackAuthHook(app, deps.registry);

  app.post('/api/callbacks/record-thread-progress', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);
    const parsed = recordThreadProgressInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const thread = await deps.threadStore.get(actor.threadId);
    if (!thread || thread.createdBy !== actor.userId || thread.deletedAt || thread.systemKind || thread.threadKind) {
      reply.status(403);
      return { error: 'Thread progress is only available for an owner-created conversation' };
    }

    const provenanceError = await validateProvenance(parsed.data.provenance, actor, deps);
    if (provenanceError) {
      reply.status(400);
      return { error: provenanceError };
    }

    const terminalIdentity = canonicalTerminalSourceIdentity(
      parsed.data.kind,
      parsed.data.provenance,
      actor.invocationId,
    );
    const now = Date.now();
    const terminalTurnKey = deriveThreadProgressSourceKey({
      ownerUserId: actor.userId,
      threadId: actor.threadId,
      canonicalTerminalSourceIdentity: `invocation:${actor.invocationId}`,
      kind: 'terminal-turn',
    });
    const result = await deps.receiptStore.appendIfAbsent(
      {
        v: 1,
        id: `progress_${randomUUID()}`,
        ownerUserId: actor.userId,
        threadId: actor.threadId,
        kind: parsed.data.kind,
        impactAxes: parsed.data.impactAxes,
        actor: { kind: 'cat', catId: actor.catId },
        headline: parsed.data.headline,
        ...(parsed.data.detail ? { detail: parsed.data.detail } : {}),
        ...(parsed.data.nextStep ? { nextStep: parsed.data.nextStep } : {}),
        provenance: parsed.data.provenance,
        sourceKey: deriveThreadProgressSourceKey({
          ownerUserId: actor.userId,
          threadId: actor.threadId,
          canonicalTerminalSourceIdentity: terminalIdentity,
          kind: parsed.data.kind,
        }),
        occurredAt: now,
        createdAt: now,
      },
      { terminalTurnKey },
    );

    reportReceiptOutcome(result, actor.threadId, deps, request.log);
    return { receiptId: result.receipt.id, inserted: result.inserted };
  });
}

function reportReceiptOutcome(
  result: AppendThreadProgressReceiptResult,
  threadId: string,
  deps: CallbackThreadProgressRouteDeps,
  log: { info(context: unknown, message: string): void },
): void {
  if (result.inserted) {
    deps.socketManager?.broadcastToRoom(`thread:${threadId}`, 'thread_brief_invalidated', { threadId });
    return;
  }
  log.info(
    { threadId, receiptId: result.receipt.id },
    'Thread progress callback resolved to an existing terminal receipt',
  );
}

function canonicalTerminalSourceIdentity(
  kind: string,
  provenance: readonly ThreadProgressSourceRef[],
  invocationId: string,
): string {
  const task = kind === 'completed' ? provenance.find((ref) => ref.kind === 'task') : undefined;
  return task?.kind === 'task' ? `task:${task.taskId}:done` : `invocation:${invocationId}`;
}

async function validateProvenance(
  provenance: readonly ThreadProgressSourceRef[],
  actor: { userId: string; threadId: string; invocationId: string },
  deps: CallbackThreadProgressRouteDeps,
): Promise<string | null> {
  for (const ref of provenance) {
    const error = await validateProvenanceRef(ref, actor, deps);
    if (error) return error;
  }
  return null;
}

async function validateProvenanceRef(
  ref: ThreadProgressSourceRef,
  actor: { userId: string; threadId: string; invocationId: string },
  deps: CallbackThreadProgressRouteDeps,
): Promise<string | null> {
  if (ref.kind === 'invocation') {
    return ref.invocationId === actor.invocationId ? null : 'Invocation provenance must match the authenticated turn';
  }
  if (ref.kind === 'message') {
    const message = await deps.messageStore.getById(ref.messageId);
    return message?.userId === actor.userId && message.threadId === actor.threadId
      ? null
      : 'Message provenance is outside the authenticated conversation';
  }
  if (!deps.taskStore) return 'Task provenance is unavailable';
  const task = await deps.taskStore.get(ref.taskId);
  return task && task.threadId === actor.threadId && (!task.userId || task.userId === actor.userId)
    ? null
    : 'Task provenance is outside the authenticated conversation';
}
