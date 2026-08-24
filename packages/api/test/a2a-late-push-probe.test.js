/**
 * F086/F216 regression guards for callback pushes that arrive while routeSerial is suspended
 * at a user-visible yield. Both windows must preserve admission-before-start/projection.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));

describe('A2A admission across re-entrant callback windows', { concurrency: false }, () => {
  test('a target pushed after prune must not be announced without a claim', async () => {
    const original = catRegistry.getAllConfigs();
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
    catRegistry.reset();
    for (const [id, config] of Object.entries(runtimeConfigs)) catRegistry.register(id, config);

    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { pushToWorklist } = await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');

      const threadId = 'thread-late-push-probe';
      const claims = [];
      const starts = [];
      let counter = 0;
      const mkService = (catId) => ({
        async *invoke() {
          starts.push(catId);
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      });
      const deps = {
        services: {
          opus: {
            async *invoke() {
              starts.push('opus');
              pushToWorklist(threadId, ['codex'], 'opus', undefined, 'trigger-1');
              yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            },
          },
          codex: mkService('codex'),
          gemini: mkService('gemini'),
        },
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => null,
            getOrCreate: async () => ({}),
            resolveWorkingDirectory: () => '/tmp/test',
          },
          threadStore: null,
          apiUrl: 'http://127.0.0.1:3004',
        },
        messageStore: {
          append: async () => ({
            id: `m-${counter}`,
            userId: '',
            catId: null,
            content: '',
            mentions: [],
            timestamp: 0,
          }),
          getById: (id) => ({ id, threadId, userId: '', catId: 'opus', content: 'body', mentions: [], timestamp: 0 }),
          getRecent: () => [],
          getMentionsFor: () => [],
          getBefore: () => [],
          getByThread: () => [],
          getByThreadAfter: () => [],
          getByThreadBefore: () => [],
        },
      };

      let latePushed = false;
      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'late push', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: (_t, catId) => {
          claims.push(catId);
          return true;
        },
        completeA2ASlots: () => {},
        deferA2AEnqueue: () => ({ outcome: 'enqueued', entry: { id: 'deferred' } }),
        thinkingMode: 'play',
      })) {
        events.push(msg);
        // Inject the late push at the first handoff yield — the reentrancy window.
        if (!latePushed && msg.type === 'a2a_handoff') {
          latePushed = true;
          pushToWorklist(threadId, ['gemini'], 'opus', undefined, 'trigger-2');
        }
      }

      const announced = events.filter((e) => e.type === 'a2a_handoff').map((e) => e.targetCatId);
      for (const cat of announced) {
        assert.ok(
          claims.includes(cat),
          `announced/started without a slot claim: ${cat}. claims=[${claims.join(',')}] ` +
            `announced=[${announced.join(',')}] starts=[${starts.join(',')}]`,
        );
      }
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  test('a target pushed after the final admission drain cannot start before slot admission', async () => {
    const original = catRegistry.getAllConfigs();
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
    catRegistry.reset();
    for (const [id, config] of Object.entries(runtimeConfigs)) catRegistry.register(id, config);

    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { pushToWorklist } = await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');

      const threadId = 'thread-terminal-admission-window';
      const timeline = [];
      let counter = 0;
      const mkService = (catId) => ({
        async *invoke() {
          timeline.push(`start:${catId}`);
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      });
      const deps = {
        services: {
          opus: mkService('opus'),
          gemini: mkService('gemini'),
        },
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => null,
            getOrCreate: async () => ({}),
            resolveWorkingDirectory: () => '/tmp/test',
          },
          threadStore: null,
          apiUrl: 'http://127.0.0.1:3004',
        },
        messageStore: {
          append: async () => ({
            id: `m-${counter}`,
            userId: '',
            catId: null,
            content: '',
            mentions: [],
            timestamp: 0,
          }),
          getById: (id) => ({ id, threadId, userId: '', catId: 'opus', content: 'body', mentions: [], timestamp: 0 }),
          getRecent: () => [],
          getMentionsFor: () => [],
          getBefore: () => [],
          getByThread: () => [],
          getByThreadAfter: () => [],
          getByThreadBefore: () => [],
        },
      };

      let injected = false;
      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'terminal window', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: (_t, catId) => {
          timeline.push(`claim:${catId}`);
          return false;
        },
        completeA2ASlots: () => {},
        deferA2AEnqueue: () => ({ outcome: 'enqueued', entry: { id: 'deferred' } }),
        thinkingMode: 'play',
      })) {
        events.push(msg);
        if (!injected && msg.type === 'done' && msg.catId === 'opus') {
          injected = true;
          pushToWorklist(threadId, ['gemini'], 'opus', undefined, 'trigger-terminal');
        }
      }

      assert.equal(injected, true, 'precondition: push must land while the final done is yielded');
      assert.equal(
        timeline.includes('start:gemini'),
        false,
        `a target whose slot claim is rejected must not start; timeline=${timeline.join(' -> ')}`,
      );
      assert.equal(
        events.some((event) => event.type === 'a2a_handoff' && event.targetCatId === 'gemini'),
        false,
        'a rejected terminal-window target must not be projected as an admitted handoff',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });
});
