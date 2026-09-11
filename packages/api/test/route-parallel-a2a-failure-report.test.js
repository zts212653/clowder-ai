import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function failingService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'error',
        catId,
        content: 'configured model unavailable',
        error: 'configured model unavailable',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function depsFor(services) {
  let invocation = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocation}`, callbackToken: `tok-${invocation}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (input) => ({ id: `unbound-${invocation}`, ...input }),
      getById: async () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
    socketManager: { broadcastToRoom() {} },
  };
}

describe('routeParallel failed A2A reporting', () => {
  test('each failed lifecycle response reports durably to the exact predecessor', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const reports = [];
    const services = {
      bengal: failingService('bengal'),
      lihua: failingService('lihua'),
    };

    for await (const _event of routeParallel(
      depsFor(services),
      ['bengal', 'lihua'],
      'ideate from Fable',
      'owner-1',
      'thread-a2a-parallel-failure',
      {
        ownerAuthProvenance: 'strict',
        a2aTriggerMessageId: 'source-from-fable',
        a2aCallerCatId: 'fable',
        parentInvocationId: 'parent-invocation',
        onLifecycleInvocationStarted: async ({ catId, invocationId, startedAt }) => ({
          responseMessageId: `response-${catId}`,
          priorFrontierMessageId: null,
          activeRun: {
            threadId: 'thread-a2a-parallel-failure',
            targetId: catId,
            invocationId,
            responseMessageId: `response-${catId}`,
            inputEntryIds: [],
            inputMessageIds: ['source-from-fable'],
            privateInputEntryIds: [],
            startedAt,
          },
        }),
        commitFailedA2AReport: async (input) => {
          reports.push(input);
          return {
            id: input.responseMessageId,
            ...input.message,
            lifecycle: { kind: 'response', ...input.terminal },
          };
        },
      },
    )) {
      // exhaust both failed children
    }

    assert.deepEqual(
      reports
        .map(({ reporterCatId, predecessorCatId, responseMessageId }) => ({
          reporterCatId,
          predecessorCatId,
          responseMessageId,
        }))
        .sort((left, right) => left.reporterCatId.localeCompare(right.reporterCatId)),
      [
        { reporterCatId: 'bengal', predecessorCatId: 'fable', responseMessageId: 'response-bengal' },
        { reporterCatId: 'lihua', predecessorCatId: 'fable', responseMessageId: 'response-lihua' },
      ],
    );
    for (const report of reports) {
      assert.equal(report.terminal.status, 'failed');
      assert.equal(report.message.content, 'configured model unavailable');
    }
  });
});
