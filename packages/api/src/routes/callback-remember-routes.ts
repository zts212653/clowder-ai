import { createHash } from 'node:crypto';
import {
  REMEMBER_QUIET_TARGETS,
  type RememberGroup,
  type RememberRowResult,
  rememberInputSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { emitStoredMessageUpdated } from '../domains/cats/services/agents/invocation/lifecycle-message-update.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { originalRememberSubmission, rememberGroupRow } from './remember-original-submission.js';
import { withWatcherRememberForward } from './watcher-remember-forward.js';

interface RememberDeps {
  registry: Pick<InvocationRegistry, 'isLatest'>;
  messageStore: Pick<IMessageStore, 'append' | 'updateExtra'>;
  socketManager: Pick<SocketManager, 'broadcastToRoom' | 'emitToUser'>;
}

/** A bounded in-process HTTP dispatch. Each original route still runs its own auth, schema and writer. */
export function registerCallbackRememberRoutes(app: FastifyInstance, deps: RememberDeps): void {
  app.post('/api/callbacks/remember', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = rememberInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
    if (!(await deps.registry.isLatest(auth.invocationId))) return { status: 'stale_ignored' };
    const groupId = `remember_${createHash('sha256')
      .update(JSON.stringify([auth.userId, auth.catId, auth.threadId, parsed.data.clientRequestId]))
      .digest('hex')
      .slice(0, 32)}`;
    const results: RememberRowResult[] = [];
    for (const item of parsed.data.items) {
      const original = originalRememberSubmission(item, groupId);
      if (!original) {
        results.push({
          itemId: item.itemId,
          target: item.target,
          statusCode: 400,
          result: { error: 'invalid_person_revision_action' },
        });
        continue;
      }
      const response = await withWatcherRememberForward(request, original.path, original.payload, () =>
        app.inject({
          method: 'POST',
          url: original.path,
          headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
          payload: original.payload,
        }),
      );
      results.push({
        itemId: item.itemId,
        target: item.target,
        statusCode: response.statusCode,
        result: response.json<unknown>(),
      });
    }
    const visible = results.filter((row) => !REMEMBER_QUIET_TARGETS.has(row.target));
    if (visible.length === 0) return { groupId, results };
    const group: RememberGroup = {
      v: 1,
      groupId,
      rows: visible.map((row) =>
        rememberGroupRow(
          row,
          parsed.data.items.find((item) => item.itemId === row.itemId),
        ),
      ),
    };
    let message = await deps.messageStore.append({
      from: { kind: 'agent', catId: auth.catId },
      userId: auth.userId,
      threadId: auth.threadId,
      content: `这次提交的 ${visible.length} 项记忆`,
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: groupId,
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              kind: 'card',
              v: 1,
              id: groupId,
              title: '这次记下的内容',
              meta: { kind: 'memory_group', memoryGroup: group },
            },
          ],
        },
      },
    });
    const rich = message.extra?.rich;
    const savedGroup = rich?.blocks.find((block) => block.kind === 'card' && block.id === groupId);
    if (rich && savedGroup?.kind === 'card' && JSON.stringify(savedGroup.meta?.memoryGroup) !== JSON.stringify(group)) {
      const updated = await deps.messageStore.updateExtra(message.id, {
        rich: {
          ...rich,
          blocks: rich.blocks.map((block) =>
            block.kind === 'card' && block.id === groupId
              ? { ...block, meta: { ...block.meta, memoryGroup: group } }
              : block,
          ),
        },
      });
      if (!updated) throw new Error('Memory group message is unavailable');
      message = updated;
      emitStoredMessageUpdated(deps.socketManager, auth.userId, message);
    }
    deps.socketManager.broadcastToRoom([`thread:${auth.threadId}`, `user:${auth.userId}`], 'connector_message', {
      threadId: auth.threadId,
      message: {
        id: message.id,
        from: message.from,
        type: 'cat',
        catId: auth.catId,
        content: message.content,
        timestamp: message.timestamp,
        extra: message.extra,
      },
    });
    return { groupId, messageId: message.id, results };
  });
}
