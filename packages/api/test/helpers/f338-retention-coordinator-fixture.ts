import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createCatId, type SessionRecord } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  CacheRetentionCoordinator,
  type CacheRetentionCoordinatorDependencies,
} from '../../src/domains/cats/services/session/cache/CacheRetentionCoordinator.js';
import type { CacheRetentionProbeReceipt } from '../../src/domains/cats/services/session/cache/CacheRetentionProbeService.js';
import { CacheRetentionSettingsStore } from '../../src/domains/cats/services/session/cache/CacheRetentionSettingsStore.js';
import { CacheRetentionStateStore } from '../../src/domains/cats/services/session/cache/CacheRetentionStateStore.js';
import type { RetentionReceiptScope } from '../../src/domains/cats/services/session/cache/cache-retention-receipt.js';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisTurnExecutionStore } from '../../src/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { cleanupClientKeyspace } from './redis-test-helpers.js';

export const base = 1_800_000_000_000;
export const minute = 60_000;
export async function retentionCoordinatorFixture(t: TestContext, options: { admitSource?: boolean } = {}) {
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `test:f338-scheduler:${randomUUID()}:` });
  let closeCoordinator: () => void | Promise<void> = () => {};
  t.after(async () => {
    await closeCoordinator();
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  const store = new CacheRetentionStateStore(redis),
    settings = new CacheRetentionSettingsStore(redis);
  const executions = new RedisTurnExecutionStore(redis);
  const record: SessionRecord = {
    id: 'parent',
    catId: createCatId('opus55'),
    threadId: 'home',
    userId: 'owner',
    seq: 0,
    status: 'active',
    cliSessionId: 'native',
    messageCount: 1,
    compressionCount: 0,
    createdAt: base,
    updatedAt: base,
    lastUsage: {
      cacheObservation: {
        invocationId: 'source',
        nativeSessionId: 'native',
        runtime: 'anthropic:sdk',
        model: 'claude-opus-5-5',
        requestStartedAt: base,
        observedAt: base + 1000,
        timeSource: 'invocation_start_lower_bound',
        contextTokens: 100_000,
        compressionCount: 0,
        retentionSource: 'usage_ttl',
        retentionMs: 60 * minute,
        confirmedWarmGapsMs: [],
      },
    },
  };
  const source = {
    id: 'dispatch',
    threadId: 'child',
    userId: 'owner',
    catId: 'opus55',
    from: { kind: 'agent', catId: 'opus55' },
    timestamp: base + 500,
    content: 'work',
    extra: { crossPost: { sourceThreadId: 'home', sourceInvocationId: 'source' } },
    lifecycle: {
      kind: 'input',
      orderKey: 'dispatch',
      dispatchRefs: [{ targetId: 'worker', phase: 'dispatched', statusMessageId: 'reply' }],
    },
  } as StoredMessage;
  const response = {
    id: 'reply',
    threadId: 'child',
    userId: 'owner',
    from: { kind: 'agent', catId: 'worker' },
    timestamp: base + 600,
    lifecycle: {
      kind: 'response',
      status: 'processing',
      targetId: 'worker',
      inputMessageIds: ['dispatch'],
      orderKey: 'reply',
    },
  } as StoredMessage;
  const messages = new Map<string, StoredMessage>([
    [source.id, source],
    [response.id, response],
  ]);
  type ProbeInput = Parameters<CacheRetentionCoordinatorDependencies['probe']['probe']>[0];
  let now = base + 50 * minute,
    queries = 0,
    beforeSend: (input: ProbeInput) => Promise<void> = async () => {};
  let afterSend: (input: ProbeInput) => Promise<void> = async () => {};
  const errors: unknown[] = [];
  const records = new Map<string, SessionRecord>([['home', record]]);
  const dependencies = {
    settings,
    cacheFacts: executions.cacheFacts,
    store,
    messages: { getById: async (id: string) => messages.get(id) ?? null },
    sessions: {
      getActive: async (_catId: unknown, threadId: string) => {
        const current = records.get(threadId);
        return current ? structuredClone(current) : null;
      },
    },
    isSupported: () => true,
    isBusy: () => false,
    now: () => now,
    onError: (error: unknown) => {
      errors.push(error);
    },
    probe: {
      readReceipt: async (input: RetentionReceiptScope) => {
        const raw = await redis.get(`fixture:maintenance-receipt:${input.attemptId}`);
        if (!raw) return null;
        const saved = JSON.parse(raw) as {
          userId: string;
          catId: string;
          threadId: string;
          receipt: CacheRetentionProbeReceipt;
        };
        return saved.userId === input.userId &&
          saved.catId === input.catId &&
          saved.threadId === input.threadId &&
          saved.receipt.sessionId === input.sessionId &&
          saved.receipt.parentNativeSessionId === input.nativeSessionId &&
          saved.receipt.sourceInvocationId === input.sourceInvocationId
          ? saved.receipt
          : null;
      },
      probe: async (
        input: Parameters<
          import('../../src/domains/cats/services/session/cache/CacheRetentionProbeService.js').CacheRetentionProbeService['probe']
        >[0],
      ) => {
        await beforeSend(input);
        await input.assertCurrent();
        // Preparation and the SDK send both reread current authority.
        await input.assertCurrent();
        const returnAfterSequence = await input.captureReturnBoundary?.();
        const queryOrdinal = ++queries;
        const startedAt = now;
        const parent = structuredClone(records.get(input.threadId)!);
        await afterSend(input);
        const receipt: CacheRetentionProbeReceipt = {
          v: 1,
          invocationId: `maintenance-${queryOrdinal}`,
          sourceInvocationId: parent.lastUsage!.cacheObservation!.invocationId,
          sessionId: parent.id,
          parentNativeSessionId: parent.cliSessionId!,
          forkNativeSessionId: `fork-${queryOrdinal}`,
          startedAt,
          endedAt: now + 1,
          returnAfterSequence,
          outcome: 'sample_pass',
          toolAttempts: 0,
          canonicalParentUnchanged: true,
          readRatio: 1,
          writeTokens: 100,
          usage: {
            numTurns: 1,
            cacheReadTokens: 100_000,
            cacheCreation1hTokens: 100,
            cacheCreation5mTokens: 0,
            inputTokens: 100_100,
            costUsd: 0.01,
          },
        };
        // Like the real Probe, its durable result exists before the window projection is written.
        await redis.set(
          `fixture:maintenance-receipt:${input.attemptId}`,
          JSON.stringify({
            userId: input.userId,
            catId: input.catId,
            threadId: input.threadId,
            receipt,
          }),
        );
        return receipt;
      },
    },
  };
  const coordinator = new CacheRetentionCoordinator(dependencies);
  const coordinators = new Set([coordinator]);
  closeCoordinator = async () => {
    await Promise.allSettled([...coordinators].map((owner) => owner.close()));
  };
  await executions.createRunning({
    invocationId: 'source',
    parentInvocationId: 'source',
    userId: 'owner',
    threadId: 'home',
    catId: 'opus55',
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: base,
  });
  await executions.markProviderStarted('source', base);
  await executions.cacheFacts.recordObservation('source', {
    sessionId: record.id,
    observation: record.lastUsage!.cacheObservation!,
  });
  await executions.recordProviderTeardown('source', base + 1000);
  await executions.transitionTerminal('source', {
    status: 'succeeded',
    endedAt: base + 1000,
    terminalReason: 'fixture',
  });
  if (options.admitSource !== false) await coordinator.observeDispatch(source, ['worker']);
  return {
    redis,
    store,
    settings,
    record,
    records,
    source,
    response,
    history: messages,
    errors,
    executions,
    returnUsage: async (id: string, read: number | undefined, at = 75) => {
      const observed = {
        ...record.lastUsage!.cacheObservation!,
        invocationId: id,
        requestStartedAt: base + at * minute,
        observedAt: base + at * minute + 1000,
        ...(read !== undefined ? { cacheReadTokens: read } : {}),
      };
      await executions.createRunning({
        invocationId: id,
        userId: 'owner',
        threadId: 'home',
        catId: 'opus55',
        parentInvocationId: id,
        executionKind: 'ordinary',
        providerLifecycleTracked: true,
        startedAt: observed.requestStartedAt,
      });
      await executions.markProviderStarted(id, observed.requestStartedAt);
      if (read !== undefined)
        await executions.cacheFacts.recordObservation(id, { sessionId: record.id, observation: observed });
      await executions.recordProviderTeardown(id, observed.observedAt);
      await executions.transitionTerminal(id, {
        status: 'succeeded',
        endedAt: observed.observedAt,
        terminalReason: 'fixture',
      });
      record.lastUsage = { cacheObservation: observed };
    },
    coordinator,
    addDispatch: async (id: string, sourceInvocationId = 'source') => {
      const nextSource = {
        ...structuredClone(source),
        id,
        timestamp: source.timestamp + 1,
        extra: { crossPost: { sourceThreadId: 'home', sourceInvocationId } },
        lifecycle: {
          kind: 'input',
          orderKey: id,
          dispatchRefs: [{ targetId: 'worker', phase: 'dispatched', statusMessageId: `${id}-reply` }],
        },
      } as StoredMessage;
      const nextResponse = {
        ...structuredClone(response),
        id: `${id}-reply`,
        lifecycle: {
          kind: 'response',
          orderKey: `${id}-reply`,
          status: 'processing',
          targetId: 'worker',
          inputMessageIds: [id],
        },
      } as StoredMessage;
      messages.set(nextSource.id, nextSource);
      messages.set(nextResponse.id, nextResponse);
      await coordinator.observeDispatch(nextSource, ['worker']);
      return { source: nextSource, response: nextResponse };
    },
    enable: () => settings.set('owner', 'opus55', true),
    queries: () => queries,
    now: () => now,
    afterSend: (fn: (input: ProbeInput) => Promise<void>) => {
      afterSend = fn;
    },
    time: (at: number) => {
      now = base + at * minute;
    },
    beforeSend: (fn: (input: ProbeInput) => Promise<void>) => {
      beforeSend = fn;
    },
    restart: () => {
      const restarted = new CacheRetentionCoordinator(dependencies);
      coordinators.add(restarted);
      return restarted;
    },
  };
}

/** Deterministic assertions may wait for receipts; the production scheduler only waits for dispatch. */
export async function settledRetentionTick(coordinator: CacheRetentionCoordinator): Promise<void> {
  await coordinator.tick();
  await coordinator.settleActive();
}
