import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  finalizeCodexStream,
  transformCodexEvent,
} from '../dist/domains/cats/services/agents/providers/codex-event-transform.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra, serializeExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { subexecutionReadbackFrames } from './helpers/f322-subexecution-readback.mjs';

function fixture(realProducer = false, childFrames = [], childBeforeText = false) {
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
    services: { codex: service },
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
