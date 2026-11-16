import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { settleResponseFromDraft } from '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { transformClaudeEvent } from '../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import {
  finalizeCodexStream,
  transformCodexEvent,
} from '../dist/domains/cats/services/agents/providers/codex-event-transform.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisDraftStore } from '../dist/domains/cats/services/stores/redis/RedisDraftStore.js';
import { commitCompletedResponseAndEnqueueA2ATargets } from '../dist/routes/callback-a2a-trigger.js';
import { HashRedis } from './helpers/f322-draft-redis.mjs';
import { subexecutionReadbackFrames } from './helpers/f322-subexecution-readback.mjs';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

function fixture(realProducer = false, childFrames = [], childBeforeText = false, legacyFrames = [], cat = 'codex') {
  const records = [],
    drafts = [],
    live = [];
  let sequence = 0;
  const native = (nativeId, channel, complete, textMode = 'replace') => ({
    provider: 'codex',
    runtimeSessionId: 'native',
    turnId: 'turn',
    nativeId,
    channel,
    complete,
    textMode,
  });
  const service = {
    async *invoke() {
      if (legacyFrames.length) {
        for (const frame of legacyFrames) yield { ...frame, catId: cat, timestamp: frame.timestamp ?? 1 };
        return;
      }
      if (childFrames.length) {
        const metadata = { provider: 'openai', model: 'gpt-6.1-sol', subexecutionEvents: [] };
        if (!childBeforeText)
          yield {
            type: 'text',
            catId: 'codex',
            content: 'Mother original body.',
            metadata: { ...metadata },
            timestamp: 1,
          };
        for (const frame of childFrames) {
          const signal = transformCodexEvent(frame, 'codex');
          assert.equal(signal.semanticEvent?.kind, 'subexecution');
          metadata.subexecutionEvents = [...metadata.subexecutionEvents, signal.semanticEvent];
          yield { ...signal, metadata: { ...metadata } };
        }
        if (childBeforeText)
          yield {
            type: 'text',
            catId: 'codex',
            content: 'Mother original body.',
            metadata: { ...metadata },
            timestamp: 1,
          };
        yield { type: 'done', catId: 'codex', timestamp: 6 };
        return;
      }
      if (realProducer) {
        const state = { hadPriorTextTurn: false, canonicalSignature: '[Sol/gpt-6.1-sol🐾]' };
        for (const [id, phase, text] of [
          ['process', 'commentary', '检查。'],
          ['answer', 'final_answer', '新回答。'],
        ]) {
          yield transformCodexEvent(
            { type: 'item.agent_message.delta', thread_id: 'native', turn_id: 'turn', item_id: id, delta: text },
            'codex',
            state,
          );
          const messages = transformCodexEvent(
            {
              type: 'item.completed',
              thread_id: 'native',
              turn_id: 'turn',
              item: { type: 'agent_message', id, phase, text },
            },
            'codex',
            state,
          );
          for (const message of Array.isArray(messages) ? messages : messages ? [messages] : []) yield message;
        }
        transformCodexEvent({ type: 'turn.completed', usage: {} }, 'codex', state);
        const suffix = finalizeCodexStream(state, 'codex');
        if (suffix) yield suffix;
        yield { type: 'done', catId: 'codex', timestamp: 6 };
        return;
      }
      yield {
        type: 'text',
        catId: 'codex',
        content: '检查。',
        outputMessage: native('process', 'commentary', true),
        timestamp: 1,
      };
      yield { type: 'tool_use', catId: 'codex', toolName: 'read', toolUseId: 'pair', timestamp: 2 };
      yield { type: 'tool_result', catId: 'codex', toolUseId: 'pair', content: 'ok', timestamp: 3 };
      yield {
        type: 'text',
        catId: 'codex',
        content: '旧',
        outputMessage: native('answer', 'final', false, 'append'),
        timestamp: 4,
      };
      yield {
        type: 'text',
        catId: 'codex',
        content: '新回答。',
        outputMessage: native('answer', 'final', true),
        timestamp: 5,
      };
      yield { type: 'done', catId: 'codex', timestamp: 6 };
    },
  };
  const store = new MessageStore();
  const append = store.append.bind(store);
  store.append = (input) => {
    const value = append(input);
    records.push(value);
    return value;
  };
  const deps = {
    services: { [cat]: service },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `child-${++sequence}`, callbackToken: 'test-token' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        consumeMentionRoutingFeedback: async () => null,
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3102',
    },
    messageStore: store,
    draftStore: {
      upsert: async (value) => drafts.push(JSON.parse(JSON.stringify(value))),
      delete: async () => {},
      touch: async () => {},
    },
  };
  return { deps, records, drafts, live };
}

function claudeFrames(summary, authored = '') {
  const state = {
    currentMessageId: undefined,
    partialTextMessageIds: new Set(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
  return [
    {
      type: 'assistant',
      narration_block_indexes: [0],
      message: {
        id: 'summary',
        content: [{ type: 'thinking', thinking: summary, signature: 'opaque' }],
      },
    },
    ...(authored
      ? [{ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: authored }] } }]
      : []),
  ]
    .flatMap((event) => {
      const result = transformClaudeEvent(event, 'opus', state);
      return Array.isArray(result) ? result : result ? [result] : [];
    })
    .concat({ type: 'done', catId: 'opus', timestamp: 6 });
}

for (const authored of ['', '@codex\n请接这项工作。']) {
  test(`serial: summary cannot enqueue a wake; authored handoff remains valid (${Boolean(authored)})`, async () => {
    const summary = '@codex\n我会请砚砚跟进。';
    const { deps } = fixture(false, [], false, claudeFrames(summary, authored), 'opus');
    const queue = new InvocationQueue();
    const persistenceContext = { errors: [], failed: false };
    let responseId;
    for await (const _event of routeSerial(deps, ['opus'], 'work', 'user-test', 'thread-test', {
      persistenceContext,
      onLifecycleInvocationStarted: async (input) => {
        const response = await appendTestLifecycleResponseSource(deps.messageStore, {
          invocationId: input.invocationId,
          catId: input.catId,
          threadId: input.threadId,
          userId: input.userId,
          timestamp: input.startedAt,
        });
        responseId = response.id;
        return {
          responseMessageId: response.id,
          priorFrontierMessageId: null,
          activeRun: {
            threadId: input.threadId,
            targetId: input.catId,
            invocationId: input.invocationId,
            responseMessageId: response.id,
            inputEntryIds: [],
            inputMessageIds: [],
            privateInputEntryIds: [],
            startedAt: input.startedAt,
          },
        };
      },
      commitCompletedA2AWake: (input) =>
        commitCompletedResponseAndEnqueueA2ATargets(
          {
            messageStore: deps.messageStore,
            invocationQueue: queue,
            queueProcessor: { async requestDrain() {} },
            socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
            log: { info() {}, warn() {}, error() {} },
          },
          input,
        ),
    })) {
      /* consume production route */
    }
    assert.deepEqual(persistenceContext.errors, []);
    const response = await deps.messageStore.getById(responseId);
    assert.ok(response.content.includes(summary), 'summary must remain readable after persistence');
    assert.equal(response.lifecycle.status, 'completed');
    assert.deepEqual(response.mentions, authored ? ['codex'] : []);
    const queued = queue.list('thread-test', 'user-test');
    assert.equal(queued.length, authored ? 1 : 0, 'only an authored instruction can enter the real queue');
    if (authored) assert.equal(queued[0].payload.sourceRecordId, responseId);
  });
}

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  for (const status of ['canceled', 'interrupted']) {
    test(`${name}: ${status} recovery keeps narration literal and extracts only authored rich blocks`, async () => {
      const card = (id) =>
        '```cc_rich\n' + JSON.stringify({ v: 1, blocks: [{ v: 1, kind: 'card', id, title: id }] }) + '\n```';
      const summary = `进度摘要🐾。\n${card('summary-card')}`;
      // The long body crosses the production draft flush threshold without a timer or a sleep.
      const authored = status === 'interrupted' ? '真实正文。'.repeat(500) + card('authored-card') : '';
      const { deps, drafts } = fixture(false, [], false, claudeFrames(summary, authored), 'opus');
      const redis = new HashRedis();
      const writer = new RedisDraftStore(redis);
      const writes = [];
      deps.draftStore.upsert = (draft) => {
        drafts.push(JSON.parse(JSON.stringify(draft)));
        const write = writer.upsert(draft);
        writes.push(write);
        return write;
      };
      let responseId;
      for await (const _event of route(deps, ['opus'], 'work', 'user-test', 'thread-test', {
        onLifecycleInvocationStarted: async (input) => {
          const response = await appendTestLifecycleResponseSource(deps.messageStore, {
            invocationId: input.invocationId,
            catId: input.catId,
            threadId: input.threadId,
            userId: input.userId,
            timestamp: input.startedAt,
          });
          responseId = response.id;
          return { responseMessageId: response.id, priorFrontierMessageId: null };
        },
      })) {
        if (drafts.at(-1)?.content.includes(authored ? '"authored-card"' : '"summary-card"')) break;
      }
      const draft = drafts.at(-1);
      assert.ok(draft?.content.includes(summary), 'the real route wrote the source text to its draft');
      assert.equal((await deps.messageStore.getById(responseId)).lifecycle.status, 'processing');

      // No in-memory projection survives: read the real serialized Redis wire in a fresh store.
      await Promise.all(writes);
      const recoveredDrafts = new RedisDraftStore(redis);
      const turns = new InMemoryTurnExecutionStore();
      await turns.createRunning({
        invocationId: draft.invocationId,
        parentInvocationId: 'parent',
        threadId: draft.threadId,
        userId: draft.userId,
        catId: draft.catId,
        executionKind: 'ordinary',
        outputFence: 'open',
        startedAt: draft.updatedAt,
      });
      const input = {
        userId: draft.userId,
        threadId: draft.threadId,
        invocationId: draft.invocationId,
        status,
        reason: status === 'canceled' ? 'user_stop' : 'process_restart',
        endedAt: draft.updatedAt + 1,
      };
      await settleResponseFromDraft(
        { messageStore: deps.messageStore, draftStore: recoveredDrafts, turnStore: turns },
        input,
      );
      const stored = await deps.messageStore.getById(responseId);
      assert.equal(stored.lifecycle.status, status);
      assert.ok(stored.content.includes(summary), 'summary rich syntax must remain readable verbatim');
      assert.deepEqual(stored.extra?.rich?.blocks?.map((block) => block.id) ?? [], authored ? ['authored-card'] : []);
      if (authored) assert.ok(!stored.content.includes('"authored-card"'));
      assert.deepEqual(await recoveredDrafts.getByThread(draft.userId, draft.threadId), []);
      const repeated = await settleResponseFromDraft(
        { messageStore: deps.messageStore, draftStore: recoveredDrafts, turnStore: turns },
        input,
      );
      assert.equal(repeated.kind, 'already_terminal');
      assert.equal(repeated.message.content, stored.content, 'recovery never reparses a committed body');
    });
  }
  test(`${name}: narration cannot cast votes or create rich blocks while authored rich text still works`, async () => {
    const card = (id) =>
      '```cc_rich\n' + JSON.stringify({ v: 1, blocks: [{ v: 1, kind: 'card', id, title: id }] }) + '\n```';
    const summary = `[VOTE:yes]\n${card('summary-card')}`;
    const { deps, records } = fixture(
      false,
      [],
      false,
      claudeFrames(summary, `真实正文。\n${card('authored-card')}`),
      'opus',
    );
    const votes = [];
    deps.invocationDeps.threadStore.getVotingState = async () => ({
      status: 'active',
      question: 'Choose',
      options: ['yes', 'no'],
      votes: {},
      voters: ['opus'],
      initiatedByCat: 'opus',
      deadline: Date.now() + 60000,
    });
    deps.invocationDeps.threadStore.updateVotingState = async (_thread, state) => votes.push(state);
    for await (const _event of route(deps, ['opus'], 'work', 'user-test', 'thread-test')) {
      /* consume */
    }
    const stored = records.find((record) => record.catId === 'opus' && record.origin === 'stream');
    assert.ok(stored.content.includes(summary), 'summary syntax must remain visible as text');
    assert.deepEqual(votes, [], 'a provider summary is not a vote');
    assert.deepEqual(
      stored.extra.rich.blocks.map((block) => block.id),
      ['authored-card'],
    );
    assert.ok(!stored.content.includes('"authored-card"'), 'authored rich blocks keep ordinary extraction');
  });
  test(`${name}: Claude narration remains in the streamed reply and cold message readback`, async () => {
    const state = {
      currentMessageId: undefined,
      partialTextMessageIds: new Set(),
      lastTurnInputTokens: undefined,
      thinkingBuffer: '',
    };
    const raw = [
      {
        type: 'assistant',
        narration_block_indexes: [0],
        message: {
          id: 'purpose',
          content: [{ type: 'thinking', thinking: '车票用来预览主画面。', signature: 'opaque' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'purpose',
          content: [{ type: 'tool_use', id: 'read', name: 'Bash', input: {} }],
        },
      },
      { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: '候选图已经发上来了。' }] } },
    ];
    const frames = raw.flatMap((event) => {
      const result = transformClaudeEvent(event, 'opus', state);
      return Array.isArray(result) ? result : result ? [result] : [];
    });
    frames.push({ type: 'done', catId: 'opus', timestamp: 6 });
    const { deps, records, live } = fixture(false, [], false, frames, 'opus');
    for await (const event of route(deps, ['opus'], 'hello', 'user-test', 'thread-test')) live.push(event);
    const stored = records.find((record) => record.catId === 'opus' && record.origin === 'stream');
    assert.ok(stored);
    assert.equal(stored.content, '车票用来预览主画面。\n\n候选图已经发上来了。');
    assert.equal((await deps.messageStore.getById(stored.id)).content, stored.content);
    assert.ok(live.some((event) => event.type === 'text' && event.content.includes('车票用来预览主画面。')));
  });
  for (const native of [false, true]) {
    test(`${name}: ${native ? 'native' : 'non-native'} done layout uses the normalized persisted body`, async () => {
      const outputMessage = (nativeId, channel) => ({
        provider: 'codex',
        runtimeSessionId: 'native',
        turnId: 'turn',
        nativeId,
        channel,
        complete: true,
        textMode: 'replace',
      });
      const cat = native ? 'codex' : 'opus';
      const frames = [
        { type: 'text', content: '先看', ...(native ? { outputMessage: outputMessage('early', 'commentary') } : {}) },
        { type: 'tool_use', toolName: 'read', toolUseId: 'read' },
        { type: 'tool_result', toolUseId: 'read', content: 'ok' },
        { type: 'text', content: '结论。\n', ...(native ? { outputMessage: outputMessage('final', 'final') } : {}) },
        { type: 'done' },
      ];
      const { deps, records, live } = fixture(false, [], false, frames, cat);
      for await (const event of route(deps, [cat], 'hello', 'user-test', 'thread-test')) live.push(event);
      const stored = records.find((record) => record.catId === cat && record.origin === 'stream');
      assert.equal(stored.content, '先看\n\n结论。');
      assert.equal(stored.extra.outputLayout.status, native ? 'unavailable' : 'available');
      if (native) assert.equal(stored.extra.outputLayout.reason, 'content_changed');
      else assert.equal(stored.extra.outputLayout.basis, 'successful_turn_last_tool');
      const done = live.filter((event) => event.type === 'done').at(-1);
      assert.deepEqual(done.extra.outputLayout, stored.extra.outputLayout);
      assert.equal(
        done.content,
        name === 'serial' ? undefined : stored.content,
        'layout consistency must preserve each route’s existing done body payload',
      );
    });
  }
  for (const cat of ['opus', 'gemini', 'kimi']) {
    test(`${name}: ${cat} successful turn attests one last-tool boundary for live done and cold history`, async () => {
      const frames = [
        { type: 'text', content: '不用你做什么，已经接上。' },
        { type: 'tool_use', toolName: 'read', toolUseId: 'read' },
        { type: 'tool_result', toolUseId: 'read', content: 'ok' },
        { type: 'text', content: '最终答复。' },
        { type: 'done' },
      ];
      const { deps, records, live, drafts } = fixture(false, [], false, frames, cat);
      for await (const event of route(deps, [cat], 'hello', 'user-test', 'thread-test')) live.push(event);
      const stored = records.find((record) => record.catId === cat && record.origin === 'stream');
      assert.ok(stored);
      assert.equal(stored.content, '不用你做什么，已经接上。\n\n最终答复。');
      assert.equal(stored.extra.outputLayout.status, 'available');
      assert.equal(stored.extra.outputLayout.basis, 'successful_turn_last_tool');
      assert.deepEqual(
        stored.extra.outputLayout.runs.map((run) => run.channel),
        ['commentary', 'final'],
      );
      assert.deepEqual(
        live.filter((event) => event.type === 'done').at(-1).extra.outputLayout,
        stored.extra.outputLayout,
      );
      assert.ok(
        live
          .filter((event) => event.type === 'text')
          .every((event) => event.extra.outputLayout.status === 'unavailable'),
      );
      assert.ok(drafts.every((draft) => draft.extra.outputLayout.status === 'unavailable'));
    });
  }
  test(`${name}: provider failure retains the same full body without a successful-boundary claim`, async () => {
    const frames = [
      { type: 'text', content: '先说的完整答复。' },
      { type: 'tool_use', toolName: 'read', toolUseId: 'read' },
      { type: 'text', content: '工具后的原话。' },
      { type: 'error', error: 'provider failed' },
      { type: 'done', errorCode: 'provider_error' },
    ];
    const { deps, records, live } = fixture(false, [], false, frames, 'opus');
    for await (const event of route(deps, ['opus'], 'hello', 'user-test', 'thread-test')) live.push(event);
    const stored = records.find((record) => record.catId === 'opus' && record.origin === 'stream');
    assert.ok(stored.content.includes('先说的完整答复。'));
    assert.ok(stored.content.includes('工具后的原话。'));
    assert.equal(stored.extra.outputLayout.status, 'unavailable');
  });
}
for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: native replacement, tool instances, Draft and formal snapshots share one public body`, async () => {
    const { deps, records, drafts, live } = fixture();
    for await (const event of route(deps, ['codex'], 'hello', 'user-test', 'thread-test')) live.push(event);
    const stored = records.find((record) => record.catId === 'codex' && record.origin === 'stream');
    assert.ok(stored);
    assert.equal(stored.content, '检查。\n\n新回答。');
    assert.equal(stored.extra.outputLayout.status, 'available');
    const text = live.filter((event) => event.type === 'text').at(-1);
    assert.equal(text.textMode, 'replace');
    assert.equal(text.content, stored.content);
    assert.deepEqual(text.extra.outputLayout, stored.extra.outputLayout);
    assert.deepEqual(drafts.at(-1).extra.outputLayout, stored.extra.outputLayout);
    assert.equal(drafts.at(-1).content, stored.content);
    const toolEvents = live.filter((event) => ['tool_use', 'tool_result'].includes(event.type));
    assert.deepEqual(
      toolEvents.map((event) => event.toolEventId),
      stored.toolEvents.map((event) => event.id),
    );
    assert.notEqual(toolEvents[0].toolEventId, toolEvents[1].toolEventId);
    assert.deepEqual(
      stored.extra.outputLayout.order.filter((ref) => ref.kind === 'tool').map((ref) => ref.toolEventId),
      stored.toolEvents.map((event) => event.id),
    );
    const done = live.filter((event) => event.type === 'done').at(-1);
    assert.deepEqual(done.extra.outputLayout, stored.extra.outputLayout);
  });
}

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: real Codex producer suffix keeps live/Draft/formal terminal layout available`, async () => {
    const { deps, records, drafts, live } = fixture(true);
    for await (const event of route(deps, ['codex'], 'hello', 'user-test', 'thread-test')) live.push(event);
    const stored = records.find((record) => record.catId === 'codex' && record.origin === 'stream');
    assert.ok(stored);
    assert.equal(stored.content, '检查。\n\n新回答。\n\n[Sol/gpt-6.1-sol🐾]');
    const layout = stored.extra.outputLayout;
    assert.equal(layout.status, 'available');
    assert.equal(layout.runs.at(-1).end, '检查。\n\n新回答。'.length);
    assert.equal(layout.hostTail.start, layout.runs.at(-1).end);
    assert.equal(layout.hostTail.end, stored.content.length);
    const lastText = live.filter((event) => event.type === 'text').at(-1);
    assert.equal(lastText.textMode, 'replace');
    assert.equal(lastText.content, stored.content);
    assert.deepEqual(lastText.extra.outputLayout, layout);
    assert.equal(drafts.at(-1).content, stored.content);
    assert.deepEqual(drafts.at(-1).extra.outputLayout, layout);
    assert.deepEqual(live.filter((event) => event.type === 'done').at(-1).extra.outputLayout, layout);
  });

  for (const [toolAfter, inherited] of ['first delta', 'all deltas'].flatMap((toolAfter) =>
    [false, true].map((inherited) => [toolAfter, inherited]),
  ))
    test(`${name}: signature removal after an interleaved tool preserves one answer (${toolAfter}, inherited=${inherited})`, async () => {
      const { deps, records, live } = fixture();
      const signature = '[Sol/gpt-6.1-sol🐾]';
      const body = '结论一\n\n结论二';
      deps.services.codex.invoke = async function* () {
        const state = {
          hadPriorTextTurn: false,
          signatureIdentity: 'Sol',
          canonicalSignature: inherited ? undefined : signature,
        };
        for (const [index, delta] of ['结论一', `\n\n结论二\n\n${signature}`].entries()) {
          yield transformCodexEvent(
            { type: 'item.agent_message.delta', thread_id: 'native', turn_id: 'turn', item_id: 'answer', delta },
            'codex',
            state,
          );
          if ((toolAfter === 'first delta' && index === 0) || (toolAfter === 'all deltas' && index === 1))
            yield {
              type: 'tool_result',
              catId: 'codex',
              toolUseId: 'pending-build',
              content: 'ok',
              timestamp: Date.now(),
            };
        }
        yield transformCodexEvent(
          {
            type: 'item.completed',
            thread_id: 'native',
            turn_id: 'turn',
            item: { type: 'agent_message', id: 'answer', phase: 'final_answer', text: `${body}\n\n${signature}` },
          },
          'codex',
          state,
        );
        transformCodexEvent({ type: 'turn.completed', usage: {} }, 'codex', state);
        const suffix = finalizeCodexStream(state, 'codex');
        assert.ok(suffix);
        yield suffix;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      };
      for await (const event of route(deps, ['codex'], 'hello', 'user-test', 'thread-test')) live.push(event);
      const stored = records.find((record) => record.catId === 'codex' && record.origin === 'stream');
      assert.equal(stored.content, `${body}\n\n${signature}`);
      assert.equal(stored.content.split('结论二').length - 1, 1);
      assert.equal(stored.content.split(signature).length - 1, 1);
      assert.equal(stored.extra.outputLayout.status, 'available');
      assert.equal(
        stored.extra.outputLayout.hostTail.basis,
        inherited ? 'provider_observed_fallback' : 'runtime_canonical',
      );
    });

  for (const interleaved of [false, true])
    test(`${name}: native deltas keep incremental frames and draft throttling (${interleaved ? 'interleaved tool result' : 'text only'})`, async (t) => {
      t.mock.method(Date, 'now', () => 1_800_000_000_000);
      const { deps, records, drafts, live } = fixture();
      const answer = '字'.repeat(200);
      deps.services.codex.invoke = async function* () {
        const state = { hadPriorTextTurn: false };
        if (interleaved)
          yield {
            type: 'tool_use',
            catId: 'codex',
            toolName: 'build',
            toolUseId: 'pending-build',
            timestamp: Date.now(),
          };
        for (const [index, delta] of Array.from(answer).entries()) {
          yield transformCodexEvent(
            { type: 'item.agent_message.delta', thread_id: 'native', turn_id: 'turn', item_id: 'answer', delta },
            'codex',
            state,
          );
          if (interleaved && index === 0)
            yield {
              type: 'tool_result',
              catId: 'codex',
              toolUseId: 'pending-build',
              content: 'ok',
              timestamp: Date.now(),
            };
        }
        yield transformCodexEvent(
          {
            type: 'item.completed',
            thread_id: 'native',
            turn_id: 'turn',
            item: { type: 'agent_message', id: 'answer', phase: 'final_answer', text: answer },
          },
          'codex',
          state,
        );
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      };
      for await (const event of route(deps, ['codex'], 'hello', 'user-test', 'thread-test')) live.push(event);
      const texts = live.filter((event) => event.type === 'text');
      assert.equal(texts.filter((event) => event.textMode === 'replace').length, 1);
      assert.equal(texts.filter((event) => event.textMode === 'append').length, 200);
      assert.equal(
        texts.reduce((size, event) => size + event.content.length, 0),
        400,
      );
      assert.equal(drafts.length, 2, 'first delta and completed snapshot, not one write per token');
      assert.equal(drafts.at(-1).content, answer);
      const stored = records.find((record) => record.catId === 'codex' && record.origin === 'stream');
      assert.equal(stored.content, answer);
      assert.equal(stored.extra.outputLayout.status, 'available');
    });
}

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: child signals persist the existing carrier before any later mother text`, async () => {
    const frames = subexecutionReadbackFrames().filter((frame) => frame.subexecution_id === 'child-schema');
    const { deps, records, drafts } = fixture(false, frames);
    for await (const _event of route(deps, ['codex'], 'hello', 'user-test', 'thread-test')) {
      /* consume */
    }
    const formal = records.find((record) => record.catId === 'codex' && record.origin === 'stream');
    const expected = frames.map((frame) => transformCodexEvent(frame, 'codex').semanticEvent);
    assert.ok(expected.length > 0);
    assert.equal(formal.content, 'Mother original body.');
    assert.deepEqual(formal.metadata.subexecutionEvents, expected);
    assert.deepEqual(
      drafts.map((draft) => draft.metadata?.subexecutionEvents?.length),
      [0, 1, 2, 3, 4],
    );
    assert.ok(drafts.every((draft) => draft.content === 'Mother original body.'));
    assert.deepEqual(drafts.at(-1).metadata.subexecutionEvents, expected);
  });
}

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: child-first activity has an active draft even before the mother speaks`, async () => {
    const frames = subexecutionReadbackFrames().filter((frame) => frame.subexecution_id === 'child-schema');
    const { deps, drafts } = fixture(false, frames, true);
    for await (const _event of route(deps, ['codex'], 'hello', 'user-test', 'thread-test')) {
      /* consume */
    }
    assert.equal(drafts[0]?.content, '');
    assert.equal(drafts[0]?.metadata?.subexecutionEvents.length, 1);
    assert.deepEqual(
      drafts[3]?.metadata?.subexecutionEvents,
      frames.map((frame) => transformCodexEvent(frame, 'codex').semanticEvent),
    );
  });
}
