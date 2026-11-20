import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { hostExecutionBoundaryRef } from '../../src/domains/cats/services/agents/invocation/host-execution-boundary.js';
import {
  type InvocationDeps,
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ClaudeSdkAgentService } from '../../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { SessionChainStore } from '../../src/domains/cats/services/stores/ports/SessionChainStore.js';
import type { ITurnExecutionStore } from '../../src/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { claudeSdkRuntimeFixture } from './claude-sdk-runtime-fixture.js';
import { declareKnownHostSessionFixture } from './known-host-session-fixture.js';

/** Real normal entry + final done; no transcript writer, so ordered proof cannot depend on its presence. */
export async function normalReturnFixture(t: TestContext, executions: ITurnExecutionStore) {
  const root = mkdtempSync(join(tmpdir(), 'f338-normal-return-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catId = createCatId('opus'),
    userId = 'owner',
    threadId = randomUUID();
  const sessions = new SessionChainStore();
  const record = sessions.create({ cliSessionId: 'native-parent', catId, userId, threadId });
  let read = 90_000,
    entries = 0,
    skipUsage = false;
  let priming = true;
  const observations: string[] = [];
  const deps = {
    registry: {
      create: () => ({ invocationId: randomUUID(), callbackToken: randomUUID() }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => 'native-parent',
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => root,
    },
    sessionChainStore: sessions,
    sessionCacheObservationListener: async (current: import('@cat-cafe/shared').SessionRecord) => {
      const id = current.lastUsage?.cacheObservation?.invocationId;
      if (id) observations.push(id);
    },
    turnExecutionStore: executions,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3122',
  } as unknown as InvocationDeps;
  const service = new ClaudeSdkAgentService({
    catId,
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'fixed fixture L0',
    runtimeResolver: claudeSdkRuntimeFixture,
    queryFn: ({ prompt }) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        const first = (await prompt[Symbol.asyncIterator]().next()).value;
        const created = priming ? 1000 : 0;
        entries++;
        yield { type: 'system', subtype: 'init', session_id: 'native-parent' };
        if (!skipUsage)
          yield {
            type: 'stream_event',
            event: {
              type: 'message_start',
              message: {
                id: randomUUID(),
                usage: {
                  input_tokens: 100_000 - read - created,
                  cache_read_input_tokens: read,
                  cache_creation_input_tokens: created,
                  output_tokens: 0,
                },
              },
            },
          };
        yield { type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'OK' }] } };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-parent',
          terminal_reason: 'completed',
          user_message_uuids: [first?.uuid],
          ...(skipUsage
            ? {}
            : {
                num_turns: 1,
                total_cost_usd: 0.01,
                usage: {
                  input_tokens: 100_000 - read - created,
                  cache_read_input_tokens: read,
                  output_tokens: 1,
                  cache_creation_input_tokens: created,
                  cache_creation: { ephemeral_1h_input_tokens: created, ephemeral_5m_input_tokens: 0 },
                },
              }),
        };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      },
    }),
  });
  const params = {
    catId,
    userId,
    threadId,
    prompt: 'real return fixture',
    service,
    isLastCat: true,
    capacitySnapshot: {
      capacity: {
        windowTokens: 200_000,
        inputCeilingTokens: 180_000,
        source: 'runtime' as const,
        provenance: 'fixture',
        actionable: true,
      },
      capability: service.contextCapability(),
    },
  };
  const executionBinding = await prepareInvocationExecutionBinding(deps, params);
  await declareKnownHostSessionFixture(deps, params, executionBinding);
  const source = {
    invocationId: 'source',
    nativeSessionId: 'native-parent',
    runtime: 'anthropic:sdk',
    model: 'claude-opus-4-6',
    executionBoundaryRef: hostExecutionBoundaryRef(executionBinding.hostExecutionBoundary!),
    requestStartedAt: Date.now() - 75 * 60_000,
    observedAt: Date.now() - 75 * 60_000 + 1000,
    timeSource: 'invocation_start_lower_bound' as const,
    contextTokens: 100_000,
    compressionCount: 0,
    retentionMs: 3_600_000,
    retentionSource: 'usage_ttl' as const,
    confirmedWarmGapsMs: [],
  };
  sessions.update(record.id, { lastUsage: { cacheObservation: source } });
  const fixture = {
    observations,
    record,
    source,
    sessions,
    scope: { userId, catId, threadId },
    entries: () => entries,
    run: async (ratio: number, missing = false) => {
      read = 100_000 * ratio;
      skipUsage = missing;
      const output = [];
      for await (const event of invokeSingleCat(deps, { ...params, executionBinding })) output.push(event);
      const errors = output.filter((event) => event.type === 'error');
      if (errors.length) throw new Error(JSON.stringify(errors));
      const current = sessions.getActive(catId, threadId, userId);
      return current?.lastUsage?.cacheObservation;
    },
  };
  await fixture.run(0.99);
  priming = false;
  const active = sessions.getActive(catId, threadId, userId)!;
  return { ...fixture, record: active, source: active.lastUsage!.cacheObservation! };
}
