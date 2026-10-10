import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectiveSourceIdentitySchema, createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor, type RouterLike } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore, settleLifecycleResponseInputs } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CollectiveReconsiderationRefusalError } from '../src/domains/plugin/builtin-runtime/collective-work/collective-reconsideration-refusal.js';
import { requireCurrentReconsiderationSource } from '../src/domains/plugin/builtin-runtime/collective-work/collective-reconsideration-source.js';
import './helpers/setup-cat-registry.js';

export const catId = createCatId('codex-sol');
export const threadId = 'public-reconsideration-queue';
export const userId = 'owner';
export async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Queue transition timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function reconsiderationQueueFixture(useSourceGuard = true) {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const messages = new MessageStore();
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
  const routed: string[] = [];
  const delivered: string[] = [];
  const parentIds: string[] = [];
  const settlementErrors: unknown[][] = [];
  let unavailable = false;
  const router: RouterLike = {
    async resolveExplicitTargets(targets) {
      return [...targets];
    },
    async resolveConversationTargetsAtAdmission(targets) {
      return [...targets];
    },
    async *routeExecution(_user, content, _thread, messageId, targets, _intent, options) {
      routed.push(content);
      if (content === 'old-g1' || unavailable) {
        const source = messages.getById(String(messageId));
        const marker = source?.source?.meta?.reconsideration as { purposeKey?: string } | undefined;
        const purpose = marker?.purposeKey ?? `collective-reconsider:${'4'.repeat(64)}`;
        try {
          if (useSourceGuard) {
            assert.ok(source);
            const connector = {
              async withWorkReconsiderationAuthority() {
                throw unavailable
                  ? Object.assign(new Error('Service transport unavailable'), { code: 'ECONNRESET' })
                  : Object.assign(new Error('Original g1 permission is no longer current'), {
                      code: 'WORK_DELEGATION_UNAVAILABLE',
                    });
              },
            } as unknown as CollectiveConnector;
            await requireCurrentReconsiderationSource({
              connector,
              messages,
              message: source,
              source: collectiveSourceIdentitySchema.parse(source.source?.meta?.participation),
              ownerUserId: userId,
            });
            assert.fail('The actual producer guard must reject before any delivery');
          }
          throw new CollectiveReconsiderationRefusalError(String(messageId), purpose, 'permission_not_current');
        } finally {
          // The real routeSerial done guarantee does not make a refused generator successful.
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        }
      }
      const invocationId = randomUUID();
      const parentInvocationId = String(options?.parentInvocationId);
      const startedAt = Date.now();
      turns.createRunning({
        invocationId,
        parentInvocationId,
        threadId,
        userId,
        catId,
        startedAt,
        executionKind: 'ordinary',
        causal: { triggerMessageId: messageId ?? undefined },
      });
      // This is the real Queue-to-History receiver boundary. Prompt exposure
      // is not allowed to substitute the parent for this exact child.
      const receiver = await options?.onLifecycleInvocationStarted?.({
        threadId,
        userId,
        catId,
        invocationId,
        parentInvocationId,
        startedAt,
      });
      yield {
        type: 'system_info',
        catId,
        invocationId,
        turnInvocationId: invocationId,
        turnExecutionStartedAt: startedAt,
        timestamp: startedAt,
        extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId } },
      };
      const expose = options?.onPromptMessagesExposed as (input: unknown) => Promise<unknown>;
      await expose({
        threadId,
        userId,
        catId,
        invocationId,
        messageIds: options?.persistedPromptMessageIds,
        seenAt: Date.now(),
      });
      delivered.push(content);
      turns.transitionTerminal(invocationId, {
        status: 'succeeded',
        terminalReason: 'fixture_delivery_complete',
        endedAt: Date.now(),
      });
      assert.ok(receiver);
      const terminal = messages.commitLifecycleResponseTerminal(receiver.responseMessageId, {
        invocationId,
        status: 'completed',
        completedAt: Date.now(),
        content: 'Fixture classification',
        mentions: [],
        origin: 'stream',
      });
      assert.ok(terminal.kind === 'applied' || terminal.kind === 'replayed');
      await settleLifecycleResponseInputs(messages, terminal.message, receiver.responseMessageId);
      yield { type: 'done', catId: targets[0], invocationId, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: new InvocationTracker(),
    messageStore: messages,
    turnExecutionStore: turns,
    router,
    invocationRecordStore: {
      async create(input) {
        const result = records.create(input as Parameters<InvocationRecordStore['create']>[0]);
        parentIds.push(result.invocationId);
        return result;
      },
      get: (id) => records.get(id),
      async update(id, input) {
        return records.update(id, input as Parameters<InvocationRecordStore['update']>[1]);
      },
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: {
      info() {},
      warn() {},
      error(...args) {
        settlementErrors.push(args);
      },
    },
  });
  async function enqueue(content: string, trusted = true) {
    const purposeKey = `collective-reconsider:${(content === 'old-g1' ? '1' : content === 'new-g2' ? '2' : '3').repeat(64)}`;
    const participation = {
      serviceInstanceId: 'svc_fixture000',
      collectiveId: 'col_fixture000',
      connectionId: 'con_fixture000',
      eventId: 'evt_original',
      catId,
      location: { channelId: 'general' },
      participationRevision: 1,
      actor: { kind: 'human' as const, humanId: 'human_fixture000', displayName: 'Fixture Owner' },
    };
    const result = await queue.send(
      messages,
      {
        userId,
        threadId,
        from: { kind: 'external', connectorId: 'collective' },
        content,
        mentions: [catId],
        timestamp: Date.now(),
        idempotencyKey: purposeKey,
        deliveryStatus: 'queued',
        source: {
          connector: 'collective',
          label: 'Collective',
          icon: 'collective',
          meta: {
            eventId: participation.eventId,
            participation,
            ...(trusted
              ? {
                  reconsideration: {
                    sourceMessageId: 'original-source',
                    grantRef: 'guide-grant',
                    grantRevision: content === 'old-g1' ? 1 : 2,
                    requestKind: 'guide',
                    purposeKey,
                  },
                }
              : {}),
          },
        },
      },
      {
        threadId,
        userId,
        from: { kind: 'external', connectorId: 'collective' },
        kind: 'conversation_input',
        sourceId: purposeKey,
        idempotencyKey: purposeKey,
        ownerAuthProvenance: 'unknown',
        executionScope: 'collective-participation',
        content,
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
      },
    );
    assert.ok(result.entry);
    return { entry: result.entry, message: result.message };
  }
  return {
    queue,
    ledger,
    messages,
    records,
    processor,
    routed,
    delivered,
    settlementErrors,
    enqueue,
    transportUnavailable(value: boolean) {
      unavailable = value;
    },
    parentRecords: () => parentIds.map((id) => records.get(id)),
  };
}
