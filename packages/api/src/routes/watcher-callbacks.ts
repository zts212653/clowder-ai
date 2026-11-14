import { parseWatcherSessionState } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type InvocationQueue,
  QueueAdmissionTargetUnavailableError,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { watcherSessionChainKey } from '../domains/cats/services/session/session-scope.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';

interface Options {
  registry: InvocationRegistry;
  executions: ITurnExecutionStore;
  sessions: ISessionChainStore;
  messages: IMessageStore;
  queue: Pick<InvocationQueue, 'enqueueExistingMessageDurable'>;
  maySpeak(userId: string, threadId: string, catId: string): Promise<boolean>;
  outputFence?(
    userId: string,
    threadId: string,
    catId: string,
  ): Promise<import('../domains/concierge/watcher/watcher-output-fence.js').WatcherOutputFence | null>;
  afterNudge?(input: {
    userId: string;
    threadId: string;
    catId: string;
    sourceInvocationId: string;
    targetCatId: string;
  }): Promise<unknown>;
  publish(message: Awaited<ReturnType<IMessageStore['append']>>): void;
}
const admissionBody = z.object({ toolName: z.string().min(1).max(100), callId: z.string().min(1).max(200) }).strict();
const nudgeBody = z
  .object({ sentence: z.string().trim().min(1).max(1200), sourceMessageId: z.string().min(1).max(100) })
  .strict();

export const watcherCallbackRoutes: FastifyPluginAsync<Options> = async (app, deps) => {
  registerCallbackAuthHook(app, deps.registry);
  app.post('/api/callbacks/watcher-tool-admission', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = admissionBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid watcher tool call' });
    const execution = await deps.executions.get(auth.invocationId);
    if (
      auth.toolExecutionPolicy?.mode !== 'watcher' ||
      execution?.executionKind !== 'watcher' ||
      execution.status !== 'running' ||
      execution.userId !== auth.userId ||
      execution.catId !== auth.catId ||
      execution.threadId !== auth.threadId ||
      !auth.toolExecutionPolicy.allowedToolNames.includes(parsed.data.toolName)
    )
      return reply.code(403).send({ error: 'Watcher tool scope denied' });
    const admission = await deps.registry.consumeWatcherToolCall(
      auth.invocationId,
      parsed.data.callId,
      parsed.data.toolName,
    );
    if (admission !== 'accepted')
      return reply.code(admission === 'replayed' ? 409 : 429).send({
        error:
          admission === 'replayed'
            ? 'Tool call already admitted; recover its original receipt'
            : 'Watcher six-call budget exhausted; finish the checkpoint',
      });
    return { accepted: true };
  });
  app.post('/api/callbacks/watcher-nudge', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    if (auth.toolExecutionPolicy?.mode !== 'watcher') return reply.code(403).send({ error: 'Watcher role required' });
    const parsed = nudgeBody.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'sentence must be 1–1200 characters and sourceMessageId must name the original source' });
    const session = await deps.sessions.getByChainKey(watcherSessionChainKey(auth.userId, auth.catId, auth.threadId));
    const attempt = session && parseWatcherSessionState(session.watcherState).attempt;
    if (!attempt || attempt.invocationId !== auth.invocationId || attempt.phase !== 'running')
      return reply.code(409).send({ error: 'Watcher attempt no longer current' });
    const source = await deps.executions.get(attempt.sourceInvocationId);
    const citation = await deps.messages.getById(parsed.data.sourceMessageId);
    if (
      !source ||
      source.executionKind !== 'ordinary' ||
      !source.responseSettlement ||
      source.userId !== auth.userId ||
      source.threadId !== auth.threadId ||
      !citation ||
      citation.userId !== auth.userId ||
      citation.threadId !== auth.threadId ||
      citation.recall ||
      citation._tombstone
    )
      return reply.code(403).send({ error: 'Watcher source scope denied' });
    const key = `watcher-nudge:${source.invocationId}`;
    const existing = await deps.messages.getByIdempotencyKey(auth.userId, auth.threadId, key);
    if (!(await deps.maySpeak(auth.userId, auth.threadId, auth.catId))) return { delivered: false, reason: 'quiet' };
    const watcherOutputFence = await deps.outputFence?.(auth.userId, auth.threadId, auth.catId);
    if (watcherOutputFence === null) return { delivered: false, reason: 'quiet' };
    const message =
      existing ??
      (await deps.messages.append({
        ...(watcherOutputFence ? { watcherOutputFence } : {}),
        userId: auth.userId,
        threadId: auth.threadId,
        from: { kind: 'agent', catId: auth.catId },
        content: `@${source.catId}\n\n${parsed.data.sentence}\n\n[原话](/thread/${auth.threadId}?messageId=${citation.id})`,
        timestamp: Date.now(),
        mentions: [source.catId],
        idempotencyKey: key,
        extra: {
          watcher: {
            kind: 'nudge',
            sourceInvocationId: source.invocationId,
            sourceMessageId: citation.id,
            watcherInvocationId: auth.invocationId,
          },
          turnExecution: {
            invocationId: auth.invocationId,
            parentInvocationId: auth.parentInvocationId ?? auth.invocationId,
            executionKind: 'watcher',
          },
        },
      }));
    // The same Message owns the normal target row. Busy cats receive it on their next turn; no interrupt/steer.
    try {
      await deps.queue.enqueueExistingMessageDurable(deps.messages, message.id, {
        threadId: auth.threadId,
        userId: auth.userId,
        kind: 'message_wake',
        ownerAuthProvenance: auth.ownerAuthProvenance,
        from: { kind: 'agent', catId: auth.catId },
        content: message.content,
        targetCats: [source.catId],
        intent: 'execute',
        autoExecute: true,
        exactTargets: true,
      });
    } catch (error) {
      if (!(error instanceof QueueAdmissionTargetUnavailableError)) throw error;
      // Keep the one persisted Message for a later tool call; this receipt promises no delivery.
      return { delivered: false, reason: 'target_unavailable', messageId: message.id, targetCatId: source.catId };
    }
    deps.publish(message);
    const receipt = deps.afterNudge
      ? ((await deps.afterNudge({
          userId: auth.userId,
          threadId: auth.threadId,
          catId: auth.catId,
          sourceInvocationId: source.invocationId,
          targetCatId: source.catId,
        })) as { ok?: boolean; error?: string } | undefined)
      : undefined;
    return {
      delivered: true,
      messageId: message.id,
      targetCatId: source.catId,
      receiptAttached: receipt?.ok === true,
      ...(receipt?.ok === false ? { receiptError: receipt.error } : {}),
    };
  });
};
