/** Real invokeSingleCat and durable session/response lifecycle; only the provider is deterministic.
 * The legacy scenario alone disables Windows host coverage to leave physical stop unknown. */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { SessionStore } from '../../../shared/dist/utils/index.js';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { lifecycleResponseIdempotencyKey } from '../../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { SessionManager } from '../../dist/domains/cats/services/session/SessionManager.js';
import { SessionSealer } from '../../dist/domains/cats/services/session/SessionSealer.js';
import { createDraftStore } from '../../dist/domains/cats/services/stores/factories/DraftStoreFactory.js';
import { createMessageStore } from '../../dist/domains/cats/services/stores/factories/MessageStoreFactory.js';
import { createSessionChainStore } from '../../dist/domains/cats/services/stores/factories/SessionChainStoreFactory.js';
import { commitLifecycleResponseFromAppendInput } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { isolateAccountAuthEnvironment } from './account-auth-environment.js';
import { routingJourneyDeps } from './routing-journey-deps.js';

export function restartTurns({ client, registry, turnExecutionStore, scope, windowsProviderHosts = true }) {
  const { threadId, userId, catId } = scope;
  isolateAccountAuthEnvironment();
  const originals = catRegistry.getAllConfigs();
  catRegistry.reset();
  Object.entries(originals).forEach(([id, member]) => {
    const native = { ...member, mcpSupport: false, configurationSource: 'native_tool', accountRef: undefined };
    catRegistry.register(id, id === catId ? native : member);
  });

  const calls = [];
  // `during` runs inside the provider once its session is known, so a turn can work or hang there.
  let during;
  // Covered like the real CLI services: its provider starts through spawnCli with the turn's own
  // invocationId, so on Windows the Host links the turn to a provider host before the fence.
  const service = {
    windowsProviderHosts,
    implementationSnapshot: () => ({ key: 'test:issue1838-restart', generation: 'g1', compatibilityRevision: 'g1' }),
    async *invoke(_prompt, options) {
      calls.push({ resume: options.cliSessionId ?? null });
      const sessionId = options.cliSessionId ?? `native-${randomUUID()}`;
      yield { type: 'session_init', catId, sessionId, timestamp: Date.now() };
      await during?.(options);
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const sessionChainStore = createSessionChainStore(client);
  const sessionManager = new SessionManager(new SessionStore(client));
  const messageStore = createMessageStore(client);
  const draftStore = createDraftStore(client);
  const deps = {
    ...routingJourneyDeps(undefined, undefined, service).deps.invocationDeps,
    registry,
    turnExecutionStore,
    sessionManager,
    sessionChainStore,
    sessionSealer: new SessionSealer(sessionChainStore),
    threadStore: { get: () => ({ id: threadId, projectPath: resolve(process.cwd()) }) },
  };

  // The router's admission of R: its row exists once invokeSingleCat names the durable child, and
  // its draft streams the body the turn had produced so far.
  const admitResponse = async (message, streamedBody) => {
    const startedAt = message.turnExecutionStartedAt;
    const response = await messageStore.append({
      from: { kind: 'agent', catId },
      userId,
      content: '',
      mentions: [],
      origin: 'stream',
      timestamp: startedAt,
      threadId,
      idempotencyKey: lifecycleResponseIdempotencyKey(message.turnInvocationId),
      lifecycle: {
        kind: 'response',
        orderKey: `${startedAt}:${message.turnInvocationId}`,
        invocationId: message.turnInvocationId,
        targetId: catId,
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt,
      },
    });
    if (streamedBody !== undefined) {
      await draftStore.upsert({
        userId,
        threadId,
        invocationId: message.turnInvocationId,
        catId,
        content: streamedBody,
        updatedAt: Date.now(),
      });
    }
    return { invocationId: message.turnInvocationId, responseMessageId: response.id, startedAt };
  };

  // The route and queue end every turn that finished, including one refused before its provider:
  // R takes the terminal state the turn has, then the draft and the ledger entry are released.
  const settleResponse = async (admitted, errors, streamedBody) => {
    const completed = errors.length === 0;
    await commitLifecycleResponseFromAppendInput(
      messageStore,
      admitted.responseMessageId,
      admitted.invocationId,
      completed
        ? { status: 'completed', completedAt: Date.now() }
        : { status: 'failed', completedAt: Date.now(), reason: 'execution_error' },
      {
        from: { kind: 'agent', catId },
        userId,
        content: completed ? (streamedBody ?? '') : errors.join('\n'),
        mentions: [],
        origin: 'stream',
        timestamp: admitted.startedAt,
        threadId,
      },
    );
    await draftStore.delete(userId, threadId, admitted.invocationId);
    // As QueueProcessor does since #1849: the settled R is recorded before the ledger entry goes;
    // without that record the store keeps the turn pending.
    await turnExecutionStore.markResponseSettled(admitted.invocationId, {
      kind: 'message',
      messageId: admitted.responseMessageId,
      settledAt: Date.now(),
    });
    await turnExecutionStore.clearResponsePending(admitted.invocationId);
  };

  return {
    calls,
    session: async () => ({
      logicalId: (await sessionChainStore.getActive(catId, threadId, userId))?.id ?? null,
      nativeId: (await sessionManager.get(userId, catId, threadId)) ?? null,
    }),
    /**
     * One user turn. A turn killed inside its provider keeps the R and draft it admitted, exactly as
     * the crash does; `onTurn` sees that admission before the provider is entered.
     */
    async run({ parentInvocationId, streamedBody, onTurn, inProvider } = {}) {
      during = inProvider;
      const errors = [];
      let admitted;
      const turn = invokeSingleCat(deps, {
        catId,
        service,
        userId,
        threadId,
        ...(parentInvocationId ? { parentInvocationId } : {}),
        prompt: 'CURRENT_TASK',
        systemPrompt: 'ROLE',
        isLastCat: true,
        ownerAuthProvenance: 'strict',
        rebuildPromptAfterSessionSeal: async () => 'AUTHORIZED_CONTEXT_SUMMARY\nCURRENT_TASK',
      });
      for await (const message of turn) {
        if (message.type === 'error') errors.push(message.error);
        if (message.type === 'system_info' && message.turnInvocationId && !admitted) {
          admitted = await admitResponse(message, streamedBody);
          await onTurn?.(admitted);
        }
      }
      if (admitted) await settleResponse(admitted, errors, streamedBody);
      return { errors, admitted };
    },
  };
}
