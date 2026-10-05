import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { buildInvocationContext } from '../dist/domains/cats/services/context/SystemPromptBuilder.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { assembleForTurn } from '../dist/domains/prompt-hooks/assemble-bridge.js';

const conciergeConfig = {
  enabled: true,
  skin: 'ragdoll-v1',
  displayName: '猫猫球',
  personaTone: '简短',
  dutyCatProfileId: 'opus',
  proactivePolicy: 'quiet-badge',
  muted: false,
};
const context = {
  catId: 'codex',
  mode: 'independent',
  teammates: [],
  mcpAvailable: true,
  threadId: 'home',
  threadKind: 'concierge',
  conciergeConfig,
};

test('Live replaces the old concierge whitelist in both prompt paths; ordinary duty is preserved', () => {
  for (const liveCompanion of [{ householdToolsEnabled: true }, { householdToolsEnabled: false }]) {
    const input = { ...context, liveCompanion };
    const outputs = [buildInvocationContext(input), assembleForTurn(input).conciergeLines.join('\n')];
    for (const output of outputs) {
      assert.match(output, /桌面伴随岗位/);
      assert.doesNotMatch(output, /职责：接线，不深潜|工具白名单（只许使用）|triage-plan/);
      assert.match(output, liveCompanion.householdToolsEnabled ? /search_evidence/ : /本次家内资料工具未开放/);
      assert.match(output, /读取不等于处理完成/);
    }
  }
  assert.match(buildInvocationContext(context), /职责：接线，不深潜/);
  assert.doesNotMatch(buildInvocationContext(context), /桌面伴随岗位/);
});

test('the actual serial route projects only its Host-owned Live port into duty context', async () => {
  let captured;
  let sequence = 0;
  let searchCount = 0;
  const executions = new InMemoryTurnExecutionStore();
  const created = [];
  const createRunning = executions.createRunning.bind(executions);
  executions.createRunning = (input) => {
    const result = createRunning(input);
    created.push(result.record);
    return result;
  };
  const threadStore = new ThreadStore();
  const thread = threadStore.create('owner', 'Live fixture', '/tmp');
  threadStore.updateThreadKind(thread.id, 'concierge');
  const ordinaryText = 'Find the earlier conversation.';
  const sourceMessage = (id, content) => ({
    id,
    content,
    threadId: thread.id,
    userId: 'owner',
    catId: null,
    mentions: [],
    timestamp: Date.now(),
  });
  // All controls have readable sources: removing the Live bypass must actually
  // reach the search reader, rather than being hidden by a missing-source error.
  const sources = new Map([
    ['source-true', sourceMessage('source-true', 'Start the explicitly authorized Live session.')],
    ['source-false', sourceMessage('source-false', 'Start the explicitly authorized Live session.')],
    ['ordinary-source', sourceMessage('ordinary-source', ordinaryText)],
  ]);
  const earlierMessage = {
    ...sourceMessage('earlier-message', 'An earlier readable conversation candidate.'),
    catId: 'codex',
  };
  sources.set(earlierMessage.id, earlierMessage);
  const service = {
    async *invoke(prompt, options) {
      captured = prompt;
      await options.beforeProviderLaunch?.({
        v: 1,
        message: { body: prompt },
        nativeInstructions: [],
        runtime: {},
        tools: { finalSurface: 'unknown' },
        providerNativeVisibility: 'unknown',
      });
      yield { type: 'text', catId: 'codex', content: 'fixture reply', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const deps = {
    services: { codex: service },
    invocationDeps: {
      turnExecutionStore: executions,
      registry: {
        create: () => ({ invocationId: `fixture-${++sequence}`, callbackToken: 'fixture-only' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => '/tmp' },
      threadStore,
      conciergeConfigStore: { get: async () => ({ ...conciergeConfig, dutyCatProfileId: 'codex' }) },
      apiUrl: 'http://127.0.0.1:1',
    },
    messageStore: {
      append: async (message) => ({ id: `message-${++sequence}`, ...message }),
      getById: (id) => sources.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    socketManager: { broadcastToRoom() {} },
    evidenceStore: {
      search: async () => assert.fail('ordinary duty must use the common message query, not thread aggregation'),
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: async (query, options) => {
        searchCount++;
        assert.equal(query, ordinaryText);
        assert.deepEqual(options.visibleThreadIds, [thread.id]);
        assert.deepEqual(options.excludeSource, { threadId: thread.id, messageId: 'ordinary-source' });
        return {
          passages: [
            {
              docAnchor: `thread-${thread.id}`,
              passageId: `msg-${earlierMessage.id}`,
              threadId: thread.id,
              messageId: earlierMessage.id,
              content: earlierMessage.content,
              match: 'lexical',
            },
          ],
          meta: {
            effectiveMode: 'lexical',
            degraded: true,
            sort: 'time',
            candidateLimit: 2000,
            truncated: false,
            semanticCandidatesLimited: false,
            sourceCoverage: 'unknown',
            freshness: 'unknown',
          },
        };
      },
    },
  };
  for (const householdToolsEnabled of [true, false]) {
    const liveCompanion = {
      householdToolsEnabled,
      compositionInstructions: 'HOST_COMPOSITION_CARRIER_CODEX_DUTY_OPUS',
      finished: Promise.resolve(),
      ready: async () => {},
      observe: async () => {},
    };
    for await (const _ of routeSerial(
      deps,
      ['codex'],
      'Start the explicitly authorized Live session.',
      'owner',
      thread.id,
      {
        thinkingMode: 'play',
        currentUserMessageId: `source-${householdToolsEnabled}`,
        liveCompanion,
      },
    )) {
      /* drain actual route */
    }
    assert.match(captured, /桌面伴随岗位/);
    assert.match(captured, /HOST_COMPOSITION_CARRIER_CODEX_DUTY_OPUS/);
    assert.match(captured, householdToolsEnabled ? /search_evidence/ : /本次家内资料工具未开放/);
    assert.equal(searchCount, 0, 'Live must not run the ordinary concierge message prefetch');
    assert.equal(
      created.at(-1).queueCompletionPolicy,
      'explicit_source',
      'Host port must persist the source completion policy before provider launch',
    );
  }
  for await (const _ of routeSerial(deps, ['codex'], ordinaryText, 'owner', thread.id, {
    thinkingMode: 'play',
    currentUserMessageId: 'ordinary-source',
  })) {
    /* ordinary positive control */
  }
  assert.equal(searchCount, 1, 'ordinary concierge keeps its prefetch');
  assert.match(captured, /消息检索候选/);
  assert.ok(captured.includes(earlierMessage.content), 'ordinary duty must receive its readable candidate');
  assert.equal(created.at(-1).queueCompletionPolicy, undefined);
  assert.match(captured, /职责：接线，不深潜/);
});
