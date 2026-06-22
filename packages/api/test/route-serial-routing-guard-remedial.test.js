/**
 * F177 Phase H — route-serial server-side routing guard integration.
 *
 * Pure decision coverage lives in `routing-guard-remedial.test.js`. This suite
 * locks the route-serial side effect: codex-family cats that cannot use native
 * Stop hooks get one inline remedial invoke when they end without a routing
 * exit. Exit-only remedials route the original visible content instead of
 * replacing it with a bare outlet.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

let catRegistryLock = Promise.resolve();

async function withCatRegistryLock(fn) {
  const previous = catRegistryLock;
  let release;
  catRegistryLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function createSequenceService(catId, texts, { needsGuard = true } = {}) {
  const calls = [];
  return {
    calls,
    needsServerRoutingGuard: () => needsGuard,
    async *invoke(prompt) {
      calls.push(prompt);
      const turn = texts[Math.min(calls.length - 1, texts.length - 1)] ?? '';
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: `${catId}-inv-${calls.length}` }),
        timestamp: Date.now(),
      };
      const events = Array.isArray(turn) ? turn : [{ type: 'text', content: turn }];
      for (const event of events) {
        yield { catId, timestamp: Date.now(), ...event };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(
  services,
  appendedMessages,
  { voiceMode = false, socketEvents = [], ballCustodyRecords = undefined, metadataAugments = [] } = {},
) {
  let counter = 0;
  const deps = {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `outer-inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: voiceMode
        ? {
            getParticipantsWithActivity: async () => [],
            get: async () => ({ threadId: 'voice-thread', voiceMode }),
            consumeMentionRoutingFeedback: async () => null,
            updateParticipantActivity: async () => {},
          }
        : null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++counter}`,
          userId: msg.userId ?? '',
          catId: msg.catId ?? null,
          content: msg.content ?? '',
          mentions: msg.mentions ?? [],
          timestamp: msg.timestamp ?? 0,
          source: msg.source,
          origin: msg.origin,
          mentionsUser: msg.mentionsUser,
          toolEvents: msg.toolEvents,
          extra: msg.extra,
        };
        appendedMessages.push(stored);
        return stored;
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
      augmentStreamMetadata: async (messageId, patch) => {
        metadataAugments.push({ messageId, patch });
        return true;
      },
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: () => Promise.resolve(),
      deleteByThread: () => {},
      getByThread: () => [],
    },
    socketManager: {
      broadcastToRoom(room, event, payload) {
        socketEvents.push({ room, event, payload });
      },
    },
  };
  if (ballCustodyRecords) {
    deps.ballCustody = {
      async record(event) {
        ballCustodyRecords.push(event);
      },
    };
  }
  return deps;
}

async function installFakeStreamingTtsRegistry() {
  const { initStreamingTtsRegistry } = await import('../dist/domains/cats/services/tts/StreamingTtsChunker.js');
  initStreamingTtsRegistry({
    getDefault: () => ({
      synthesize: async (request) => ({
        audio: Buffer.from(request.text),
        format: 'wav',
        durationSec: 0.1,
      }),
    }),
  });
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

async function runRoute(service, threadId, extraServices = {}, mockOptions = {}) {
  return withCatRegistryLock(async () => {
    const { thinkingMode = 'play', ...depsOptions } = mockOptions;
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    const appended = [];
    const metadataAugments = [];
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ codex: service, ...extraServices }, appended, { ...depsOptions, metadataAugments });
      const yielded = [];
      for await (const msg of routeSerial(deps, ['codex'], 'guard test', 'user1', threadId, {
        thinkingMode,
      })) {
        yielded.push(msg);
      }
      return { appended, yielded, calls: service.calls, metadataAugments };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

describe('F177 Phase H — route-serial routing guard remedial invoke', () => {
  test('guard-enabled cat with no exit gets one remedial invoke and persists the original visible content', async () => {
    const service = createSequenceService('codex', ['I will keep going from here.', '@co-creator']);

    const { appended, calls, yielded } = await runRoute(service, 'thread-routing-guard-1');

    assert.equal(calls.length, 2, 'codex service should be invoked once plus one remedial retry');
    assert.match(calls[1], /路由守卫/);
    assert.match(calls[1], /不要重做/);

    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'I will keep going from here.');
    assert.equal(
      codexMessages[0].mentionsUser,
      true,
      'co-creator route-only remedial must still mark the stored visible message as mentioning the user',
    );
    assert.equal(
      appended.find((m) => m.source?.connector === 'routing-guard-failure'),
      undefined,
      'successful remedial exit should not emit a guard failure notice',
    );

    const yieldedTextEvents = yielded.filter((m) => m.type === 'text');
    const yieldedText = yieldedTextEvents.map((m) => m.content);
    assert.deepEqual(
      yieldedText,
      ['I will keep going from here.'],
      'live stream must surface the first-pass visible text after the route-only remedial validates it',
    );
    const done = yielded.find((m) => m.type === 'done');
    assert.equal(done?.mentionsUser, true, 'final done event should preserve co-creator mention notification');
    assert.equal(
      yieldedTextEvents[0]?.invocationId,
      done?.invocationId,
      'preserved first-pass text must be restamped to the same remedial turn identity as done',
    );
  });

  test('guarded first pass streams lifecycle and tool events while withholding invalid text', async () => {
    const service = createSequenceService('codex', [
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_search_evidence',
          toolInput: { q: 'thread opus' },
        },
        {
          type: 'tool_result',
          content: '{"status":"ok","results":[{"id":"e1"}]}',
        },
        { type: 'text', content: 'Invalid first-pass response.' },
      ],
      '@co-creator',
    ]);

    const { appended, calls, yielded } = await runRoute(service, 'thread-routing-guard-lifecycle');

    assert.equal(calls.length, 2, 'first-pass no-exit text should still trigger one remedial invoke');
    const yieldedInvocationIds = yielded
      .filter((m) => m.type === 'system_info' && m.content)
      .map((m) => {
        try {
          const parsed = JSON.parse(m.content);
          return parsed.type === 'invocation_created' ? parsed.invocationId : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const firstPassInvocationIndex = yieldedInvocationIds.indexOf('codex-inv-1');
    const remedialInvocationIndex = yieldedInvocationIds.indexOf('codex-inv-2');
    assert.ok(firstPassInvocationIndex >= 0, 'guard must stream the first-pass invocation lifecycle event');
    assert.ok(remedialInvocationIndex >= 0, 'remedial invocation lifecycle event should still stream');
    assert.ok(
      firstPassInvocationIndex < remedialInvocationIndex,
      'first-pass lifecycle must stream before the remedial turn completes',
    );
    assert.deepEqual(
      yielded.filter((m) => m.type === 'tool_use' || m.type === 'tool_result').map((m) => [m.type, m.toolName ?? null]),
      [
        ['tool_use', 'cat_cafe_search_evidence'],
        ['tool_result', null],
      ],
      'guard must not delay tool progress events behind routing validation',
    );
    assert.deepEqual(
      yielded.filter((m) => m.type === 'text').map((m) => m.content),
      ['Invalid first-pass response.'],
      'first-pass text should be withheld until the route-only remedial validates it',
    );

    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'Invalid first-pass response.');
  });

  test('markdown-prefixed co-creator route-only remedial preserves mention notifications', async () => {
    const service = createSequenceService('codex', ['I will escalate this to the co-creator.', '1) @co-creator']);

    const { appended, calls, yielded } = await runRoute(service, 'thread-routing-guard-prefixed-co-creator');

    assert.equal(calls.length, 2, 'first-pass no-exit text should trigger one remedial invoke');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'I will escalate this to the co-creator.');
    assert.equal(codexMessages[0].mentionsUser, true);
    assert.equal(
      appended.find((m) => m.source?.connector === 'routing-guard-failure'),
      undefined,
      'markdown-prefixed co-creator remedial should count as a valid routing exit',
    );
    const done = yielded.find((m) => m.type === 'done');
    assert.equal(done?.mentionsUser, true);
  });

  test('punctuated co-creator route-only remedial preserves original rich content', async () => {
    const richBlock = {
      id: 'generated-image-punctuated-co-creator',
      kind: 'media_gallery',
      v: 1,
      title: 'codex:image_gen',
      items: [{ url: '/uploads/generated-image-punctuated.png', alt: 'generated image' }],
    };
    const service = createSequenceService('codex', [
      [
        {
          type: 'system_info',
          content: JSON.stringify({ type: 'rich_block', block: richBlock }),
        },
        { type: 'text', content: 'Here is the generated cover candidate.' },
      ],
      '@co-creator。',
    ]);

    const { appended, calls, yielded } = await runRoute(service, 'thread-routing-guard-punctuated-co-creator');

    assert.equal(calls.length, 2, 'punctuated route-only remedial should validate the guarded response');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'Here is the generated cover candidate.');
    assert.equal(codexMessages[0].mentionsUser, true);
    assert.deepEqual(codexMessages[0].extra?.rich?.blocks, [richBlock]);
    const done = yielded.find((m) => m.type === 'done');
    assert.equal(done?.mentionsUser, true);
  });

  test('remedial line-start cat mention flows through existing A2A worklist enqueue', async () => {
    const codexService = createSequenceService('codex', ['I will keep going from here.', '@opus']);
    const opusService = createSequenceService('opus', ['ack from opus'], { needsGuard: false });

    const { appended, calls } = await runRoute(codexService, 'thread-routing-guard-1b', { opus: opusService });

    assert.equal(calls.length, 2, 'codex should run initial turn plus remedial turn');
    assert.equal(opusService.calls.length, 1, 'remedial @opus should enqueue and invoke opus');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'I will keep going from here.');
    assert.deepEqual(codexMessages[0].mentions, ['opus']);
  });

  test('debug A2A prompt sees validated first-pass content routed by remedial exit', async () => {
    const codexService = createSequenceService('codex', ['First-pass debug context.', '@opus']);
    const opusService = createSequenceService('opus', ['ack from opus'], { needsGuard: false });

    const { calls } = await runRoute(
      codexService,
      'thread-routing-guard-debug-context',
      { opus: opusService },
      { thinkingMode: 'debug' },
    );

    assert.equal(calls.length, 2, 'codex should run initial turn plus remedial turn');
    assert.equal(opusService.calls.length, 1, 'remedial @opus should enqueue opus');
    assert.match(
      opusService.calls[0],
      /\[codex responded: First-pass debug context\.\]/,
      'debug context should expose the final persisted visible response',
    );
    assert.doesNotMatch(
      opusService.calls[0],
      /\[codex responded: @opus\]/,
      'debug context should not expose a bare route-only patch as the visible response',
    );
  });

  test('tool-only hold_ball remedial counts as an exit and keeps the original text visible', async () => {
    const service = createSequenceService('codex', [
      '我先持球继续。',
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_hold_ball',
          toolInput: { wakeAfterSeconds: 60, reason: '等外部结果' },
        },
      ],
    ]);

    const { appended, calls, yielded } = await runRoute(service, 'thread-routing-guard-1c');

    assert.equal(calls.length, 2, 'fake-hold should trigger one remedial invoke');
    assert.equal(
      appended.find((m) => m.source?.connector === 'routing-guard-failure'),
      undefined,
      'hold_ball tool-only remedial is a valid exit',
    );
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, '我先持球继续。');
    assert.deepEqual(
      yielded.filter((m) => m.type === 'text').map((m) => m.content),
      ['我先持球继续。'],
      'tool-only remedial exits keep the original text, so the live stream must re-emit it too',
    );
  });

  test('tool-only no-text initial output still gets the remedial guard instead of silent completion', async () => {
    const service = createSequenceService('codex', [
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_search_evidence',
          toolInput: { q: 'thread opus' },
        },
      ],
      '@co-creator',
    ]);

    const { appended, calls, yielded } = await runRoute(service, 'thread-routing-guard-1d');

    assert.equal(calls.length, 2, 'tool-only no-exit output should trigger one remedial invoke');
    assert.equal(
      yielded.some((m) => {
        if (m.type !== 'system_info' || !m.content) return false;
        try {
          return JSON.parse(m.content).type === 'silent_completion';
        } catch {
          return false;
        }
      }),
      false,
      'guarded tool-only turns should be remediated, not surfaced as silent_completion',
    );
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, '@co-creator');
  });

  test('confirmed callback post with line-start cat mention counts as the routing exit', async () => {
    const service = createSequenceService('codex', [
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_post_message',
          toolInput: { content: '@opus\n\nCallback handoff from the tool content.' },
        },
        {
          type: 'tool_result',
          toolName: 'cat_cafe_post_message',
          content: '{"status":"ok","messageId":"msg-callback","threadId":"thread-routing-guard-callback"}',
        },
      ],
      '@co-creator',
    ]);

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-callback');

    assert.equal(calls.length, 1, 'confirmed callback handoff must not trigger a duplicate remedial invoke');
    assert.equal(
      appended.find((m) => m.source?.connector === 'routing-guard-failure'),
      undefined,
      'confirmed callback handoff should not emit a routing guard failure notice',
    );
  });

  test('confirmed cross-thread post with self line-start mention counts as the routing exit', async () => {
    const service = createSequenceService('codex', [
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_cross_post_message',
          toolInput: { content: '@codex\n\nCross-thread handoff back to this cat in another thread.' },
        },
        {
          type: 'tool_result',
          toolName: 'cat_cafe_cross_post_message',
          content: '{"status":"ok","messageId":"msg-cross","threadId":"thread-routing-guard-cross-target"}',
        },
      ],
      '@co-creator',
    ]);

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-cross-self');

    assert.equal(calls.length, 1, 'confirmed cross-thread self handoff must not trigger duplicate remediation');
    assert.equal(
      appended.find((m) => m.source?.connector === 'routing-guard-failure'),
      undefined,
      'confirmed cross-thread self handoff should not emit a routing guard failure notice',
    );
  });

  test('callback routing consumer contract covers callback tool matrix', async () => {
    const { classifyCallbackContentRoutingState } = await import(
      '../dist/domains/cats/services/agents/routing/route-serial.js'
    );
    assert.equal(typeof classifyCallbackContentRoutingState, 'function');
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();

    const toolCases = [
      {
        kind: 'post',
        toolName: 'cat_cafe_post_message',
        resultToolName: 'mcp:cat-cafe/post_message',
        scope: 'local',
      },
      {
        kind: 'cross',
        toolName: 'cat_cafe_cross_post_message',
        resultToolName: 'mcp:cat-cafe/cross_post_message',
        scope: 'target',
      },
    ];
    const mentionCases = [
      {
        kind: 'cat',
        content: '@opus\ncallback handoff',
        guardMentions: ['opus'],
        expectSourceWorklist: (scope) => scope === 'local',
        expectSourceMentionsUser: () => false,
      },
      {
        kind: 'cvo',
        content: '@co-creator\ncallback escalation',
        guardMentions: [],
        expectSourceWorklist: () => false,
        expectSourceMentionsUser: (scope) => scope === 'local',
      },
    ];

    try {
      for (const toolCase of toolCases) {
        for (const hasToolUseId of [true, false]) {
          for (const mentionCase of mentionCases) {
            const label = `${toolCase.kind}/${toolCase.scope}/${hasToolUseId ? 'toolUseId' : 'no-id'}/${mentionCase.kind}`;
            const localThreadId = `thread-routing-contract-${toolCase.kind}-${hasToolUseId ? 'id' : 'no-id'}-${mentionCase.kind}`;
            const resultThreadId = toolCase.scope === 'target' ? `${localThreadId}-target` : localThreadId;
            const messageId = `msg-routing-contract-${toolCase.kind}-${hasToolUseId ? 'id' : 'no-id'}-${mentionCase.kind}`;
            const toolUseId = `${toolCase.kind}-${mentionCase.kind}-tool-use`;
            const expectedSourceWorklist = mentionCase.expectSourceWorklist(toolCase.scope);
            const expectedSourceMentionsUser = mentionCase.expectSourceMentionsUser(toolCase.scope);

            const state = classifyCallbackContentRoutingState(toolCase.toolName, mentionCase.content, 'codex');
            assert.deepEqual(
              state,
              {
                scope: toolCase.scope,
                guardLineStartMentions: mentionCase.guardMentions,
                localLineStartMentions: toolCase.scope === 'local' ? mentionCase.guardMentions : [],
                hasGuardCoCreatorLineStartMention: mentionCase.kind === 'cvo',
                hasLocalCoCreatorLineStartMention: toolCase.scope === 'local' && mentionCase.kind === 'cvo',
                hasTargetCoCreatorLineStartMention: toolCase.scope === 'target' && mentionCase.kind === 'cvo',
              },
              `${label}: callback routing state must be explicit`,
            );

            const recorded = [];
            const service = createSequenceService('codex', [
              [
                {
                  type: 'tool_use',
                  toolName: toolCase.toolName,
                  ...(hasToolUseId ? { toolUseId } : {}),
                  toolInput: {
                    ...(toolCase.scope === 'target' ? { threadId: resultThreadId } : {}),
                    content: mentionCase.content,
                  },
                },
                {
                  type: 'tool_result',
                  toolName: toolCase.resultToolName,
                  ...(hasToolUseId ? { toolUseId } : {}),
                  content: JSON.stringify({ status: 'ok', messageId, threadId: resultThreadId }),
                },
                {
                  type: 'text',
                  content: `${label}: local source follow-up without a line-start route`,
                },
              ],
              '@co-creator',
            ]);
            const opusService = createSequenceService('opus', [`${label}: opus ack`], { needsGuard: false });

            const { appended, calls, metadataAugments } = await runRoute(
              service,
              localThreadId,
              { opus: opusService },
              { ballCustodyRecords: recorded },
            );

            assert.equal(calls.length, 1, `${label}: confirmed callback exit must satisfy the routing guard`);
            assert.equal(
              appended.find((m) => m.source?.connector === 'routing-guard-failure'),
              undefined,
              `${label}: confirmed callback exit must not emit a routing guard failure notice`,
            );
            assert.equal(
              opusService.calls.length,
              expectedSourceWorklist ? 1 : 0,
              `${label}: source worklist enqueue must follow local callback mention state`,
            );

            const sourceMentionsUser =
              toolCase.scope === 'local'
                ? metadataAugments.some((entry) => entry.messageId === messageId && entry.patch.mentionsUser === true)
                : appended.some((m) => m.catId === 'codex' && m.origin === 'stream' && m.mentionsUser === true);
            assert.equal(
              sourceMentionsUser,
              expectedSourceMentionsUser,
              `${label}: source mentionsUser must follow local operator state`,
            );

            const expectedCvo =
              mentionCase.kind === 'cvo' ? [[`route:${messageId}`, `ball:thread:${resultThreadId}`]] : [];
            assert.deepEqual(
              recorded
                .filter((event) => event.kind === 'ball.handed_cvo')
                .map((event) => [event.sourceEventId, event.subjectKey]),
              expectedCvo,
              `${label}: operator handoff must bind to the callback delivery scope`,
            );
          }
        }
      }
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('cross-post operator callback does not mark the source thread as mentioning the user', async () => {
    const recorded = [];
    const service = createSequenceService('codex', [
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_cross_post_message',
          toolInput: {
            threadId: 'thread-routing-cross-cvo-target',
            content: '@co-creator\ncross-thread escalation',
          },
        },
        {
          type: 'tool_result',
          toolName: 'cat_cafe_cross_post_message',
          content: JSON.stringify({
            status: 'ok',
            messageId: 'msg-routing-cross-cvo',
            threadId: 'thread-routing-cross-cvo-target',
          }),
        },
        {
          type: 'text',
          content: 'local thread follow-up after target-thread escalation',
        },
      ],
      '@co-creator',
    ]);

    const { appended, calls } = await runRoute(
      service,
      'thread-routing-cross-cvo-source',
      {},
      { ballCustodyRecords: recorded },
    );

    assert.equal(calls.length, 1, 'confirmed cross-post operator callback must satisfy the routing guard');
    assert.deepEqual(
      recorded
        .filter((event) => event.kind === 'ball.handed_cvo')
        .map((event) => [event.sourceEventId, event.subjectKey]),
      [['route:msg-routing-cross-cvo', 'ball:thread:thread-routing-cross-cvo-target']],
      'cross-post operator handoff must bind to the target thread',
    );

    const sourceMessage = appended.find((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.ok(sourceMessage, 'local follow-up should persist in the source thread');
    assert.equal(sourceMessage.content, 'local thread follow-up after target-thread escalation');
    assert.equal(
      sourceMessage.mentionsUser,
      undefined,
      'target-thread operator callback must not create a source-thread user mention notification',
    );
  });

  test('tool-only hold_ball remedial preserves rich blocks attached to the original text', async () => {
    const richBlock = {
      id: 'guard-card-1',
      kind: 'card',
      v: 1,
      title: 'Routing Guard Context',
      bodyMarkdown: 'This block belongs to the original response.',
    };
    const service = createSequenceService('codex', [
      [
        {
          type: 'system_info',
          content: JSON.stringify({ type: 'rich_block', block: richBlock }),
        },
        { type: 'text', content: '我先持球继续。' },
      ],
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_hold_ball',
          toolInput: { wakeAfterSeconds: 60, reason: '等外部结果' },
        },
      ],
    ]);

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-1e');

    assert.equal(calls.length, 2, 'original rich-block response should still trigger fake-hold remediation');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, '我先持球继续。');
    assert.deepEqual(
      codexMessages[0].extra?.rich?.blocks,
      [richBlock],
      'tool-only remedial exit keeps original text, so it must keep original rich blocks too',
    );
  });

  test('route-only text remedial preserves original text and rich blocks from the original response', async () => {
    const richBlock = {
      id: 'generated-image-1',
      kind: 'media_gallery',
      v: 1,
      title: 'codex:image_gen',
      items: [{ url: '/uploads/generated-image.png', alt: 'generated image' }],
    };
    const service = createSequenceService('codex', [
      [
        {
          type: 'system_info',
          content: JSON.stringify({ type: 'rich_block', block: richBlock }),
        },
        { type: 'text', content: 'Here is the generated title card.' },
      ],
      '@co-creator',
    ]);

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-rich-text-remedial');

    assert.equal(calls.length, 2, 'original rich-block response should trigger route-only remediation');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'Here is the generated title card.');
    assert.deepEqual(
      codexMessages[0].extra?.rich?.blocks,
      [richBlock],
      'route-only text remedial must not drop first-pass generated image rich blocks on F5',
    );
  });

  test('route-only remedial with numbered parenthesis prefix routes while preserving original rich content', async () => {
    const richBlock = {
      id: 'generated-image-2',
      kind: 'media_gallery',
      v: 1,
      title: 'codex:image_gen',
      items: [{ url: '/uploads/generated-image-2.png', alt: 'generated image' }],
    };
    const codexService = createSequenceService('codex', [
      [
        {
          type: 'system_info',
          content: JSON.stringify({ type: 'rich_block', block: richBlock }),
        },
        { type: 'text', content: 'Here is the generated title card with details.' },
      ],
      '1) @opus',
    ]);
    const opusService = createSequenceService('opus', ['ack from opus'], { needsGuard: false });

    const { appended, calls } = await runRoute(codexService, 'thread-routing-guard-rich-numbered-remedial', {
      opus: opusService,
    });

    assert.equal(calls.length, 2, 'original rich-block response should trigger route-only remediation');
    assert.equal(opusService.calls.length, 1, 'numbered parenthesis route-only remedial should enqueue opus');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'Here is the generated title card with details.');
    assert.deepEqual(codexMessages[0].mentions, ['opus']);
    assert.deepEqual(codexMessages[0].extra?.rich?.blocks, [richBlock]);
  });

  test('tool-only hold_ball remedial preserves original tool events when keeping the original text', async () => {
    const service = createSequenceService('codex', [
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_search_evidence',
          toolInput: { q: 'thread opus' },
        },
        {
          type: 'tool_result',
          content: '{"status":"ok","results":[{"id":"e1"}]}',
        },
        { type: 'text', content: '证据查完了，我先持球继续。' },
      ],
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_hold_ball',
          toolInput: { wakeAfterSeconds: 60, reason: '等外部结果' },
        },
      ],
    ]);

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-1f');

    assert.equal(calls.length, 2, 'original tool-using response should trigger fake-hold remediation');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, '证据查完了，我先持球继续。');
    assert.deepEqual(
      codexMessages[0].toolEvents?.map((event) => [event.type, event.toolName ?? null]),
      [
        ['tool_use', 'cat_cafe_search_evidence'],
        ['tool_result', null],
        ['tool_use', 'cat_cafe_hold_ball'],
      ],
      'when remedial keeps original text, persisted toolEvents must keep original work evidence plus the routing exit',
    );
  });

  test('voice-mode route-only remediation speaks the validated first-pass text', async () => {
    await installFakeStreamingTtsRegistry();
    const service = createSequenceService('codex', ['Invalid first-pass response.', '@co-creator']);
    const socketEvents = [];

    const { calls } = await runRoute(service, 'thread-routing-guard-voice', {}, { voiceMode: true, socketEvents });

    assert.equal(calls.length, 2, 'voice-mode no-exit output should still trigger one remedial invoke');
    const spokenChunks = socketEvents.filter((e) => e.event === 'voice_chunk').map((e) => e.payload.text);
    assert.deepEqual(
      spokenChunks,
      ['Invalid first-pass response.'],
      'voice TTS must follow the same validated visible text as live/persistence',
    );
    assert.equal(
      spokenChunks.includes('@co-creator'),
      false,
      'route-only remedial text must not be synthesized as user-visible speech',
    );
  });

  test('voice-mode tool-only remediation speaks the preserved original text', async () => {
    await installFakeStreamingTtsRegistry();
    const service = createSequenceService('codex', [
      '我先持球继续。',
      [
        {
          type: 'tool_use',
          toolName: 'cat_cafe_hold_ball',
          toolInput: { wakeAfterSeconds: 60, reason: '等外部结果' },
        },
      ],
    ]);
    const socketEvents = [];

    const { calls, yielded } = await runRoute(
      service,
      'thread-routing-guard-voice-tool-only',
      {},
      {
        voiceMode: true,
        socketEvents,
      },
    );

    assert.equal(calls.length, 2, 'voice-mode tool-only routing exit should still remediate once');
    assert.deepEqual(
      yielded.filter((m) => m.type === 'text').map((m) => m.content),
      ['我先持球继续。'],
      'live text stream should show the original text after the tool-only remedial exit validates it',
    );
    const spokenChunks = socketEvents.filter((e) => e.event === 'voice_chunk').map((e) => e.payload.text);
    assert.deepEqual(spokenChunks, ['我先持球继续。'], 'voice TTS should match the preserved live text');
  });

  test('guard-disabled cat still runs once and keeps legacy non-blocking hint behavior', async () => {
    const service = createSequenceService('codex', ['I will keep going from here.'], { needsGuard: false });

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-2');

    assert.equal(calls.length, 1, 'cats with native Stop-hook coverage must not get server re-invoked');
    const codexMessages = appended.filter((m) => m.catId === 'codex' && m.origin === 'stream');
    assert.equal(codexMessages.length, 1);
    assert.equal(codexMessages[0].content, 'I will keep going from here.');
  });

  test('remedial output without an exit emits visible failure and does not invoke a third time', async () => {
    const service = createSequenceService('codex', [
      'I will keep going from here.',
      'Still continuing without a route.',
    ]);

    const { appended, calls } = await runRoute(service, 'thread-routing-guard-3');

    assert.equal(calls.length, 2, 'one-shot cost guard must prevent a third codex invocation');
    const failure = appended.find((m) => m.source?.connector === 'routing-guard-failure');
    assert.ok(failure, 'second no-exit output must be surfaced as a visible routing guard failure');
    assert.match(failure.content, /补救失败|没有合法的路由出口/);
  });
});
