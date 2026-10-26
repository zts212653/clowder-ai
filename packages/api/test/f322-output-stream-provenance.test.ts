import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';
import { mapCodexAppServerNotification } from '../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.js';
import {
  type CodexStreamState,
  transformCodexEvent,
} from '../src/domains/cats/services/agents/providers/codex-event-transform.js';
import { RoutingMessageOutputProjection } from '../src/domains/cats/services/agents/routing/message-output-projection.js';
import { createRoutingMessageTransform } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';

const observation = {
  provider: 'codex',
  runtimeSessionId: 'native',
  turnId: 'turn',
  nativeId: 'answer',
  channel: 'final' as const,
  complete: true,
  textMode: 'replace' as const,
};
const input: AgentMessage = {
  type: 'text',
  catId: 'codex61-sol' as AgentMessage['catId'],
  timestamp: 1,
  invocationId: 'child',
  content: '正文。\n{',
  outputMessage: observation,
};

test('a deferred flush retains its unique native provenance without redefining native mode', () => {
  const transform = createRoutingMessageTransform();
  const prefix = transform.transform(input)[0];
  assert.equal(prefix.content, '正文。');
  const flushed = transform.transform({ type: 'done', catId: input.catId, timestamp: 2 })[0];
  assert.equal(flushed.content, '\n{');
  assert.deepEqual(flushed.outputMessage, observation);
  assert.equal(flushed.invocationId, 'child');
  assert.deepEqual(transform.outputFactsFor?.(prefix), { complete: false, changed: false });
  assert.deepEqual(transform.outputFactsFor?.(flushed), { mode: 'append', complete: true, changed: false });
});

test('a buffer spanning different native identities cannot attribute composed text to either one', () => {
  const transform = createRoutingMessageTransform();
  transform.transform(input);
  const second = transform.transform({
    ...input,
    content: 'still pending',
    outputMessage: { ...observation, nativeId: 'other' },
  });
  const final = transform.transform({ type: 'done', catId: input.catId, timestamp: 3 });
  for (const message of [...second, ...final].filter((value) => value.type === 'text')) {
    assert.equal(message.outputMessage, undefined);
  }
});

test('buffered native completion becomes available only after its final public fragment', () => {
  const transform = createRoutingMessageTransform();
  let state = createMessageOutputState({ threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' });
  const first = transform.transform(input)[0];
  state = accumulateMessageOutputText(state, {
    content: first.content ?? '',
    outputMessage: first.outputMessage,
    fragment: transform.outputFactsFor(first),
  });
  assert.equal(materializeMessageOutput(state).layout.status, 'unavailable');
  const last = transform.transform({ type: 'done', timestamp: 2 })[0];
  state = accumulateMessageOutputText(state, {
    content: last.content ?? '',
    outputMessage: last.outputMessage,
    fragment: transform.outputFactsFor(last),
  });
  assert.equal(materializeMessageOutput(state).content, input.content);
  assert.equal(materializeMessageOutput(state).layout.status, 'available');
});

test('a sanitizer rewrite preserves readable text but cannot prove complete native ranges', () => {
  const transform = createRoutingMessageTransform();
  let state = createMessageOutputState({ threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' });
  const messages = [
    ...transform.transform({
      ...input,
      content: 'visible\n{"recipient_name":"functions.exec_command","parameters":{"cmd":"x"}}',
    }),
    ...transform.transform({ type: 'done', timestamp: 2 }),
  ];
  for (const msg of messages.filter((m) => m.type === 'text'))
    state = accumulateMessageOutputText(state, {
      content: msg.content ?? '',
      outputMessage: msg.outputMessage,
      fragment: transform.outputFactsFor(msg),
    });
  assert.equal(materializeMessageOutput(state).layout.status, 'unavailable');
  assert.ok(materializeMessageOutput(state).content.includes('visible'));
});

// Exercise the boundary missed by the separate streaming and accumulator tests:
// app-server notifications → adapter → sanitizer → the one persisted message body.
function stream() {
  const state: CodexStreamState = { hadPriorTextTurn: false };
  const transform = createRoutingMessageTransform();
  const projection = new RoutingMessageOutputProjection({
    threadId: 'thread',
    catId: 'codex61-sol',
    turnInvocationId: 'child',
  });
  function emit(message: AgentMessage) {
    for (const output of transform.transform(message)) {
      if (output.type === 'text') projection.text(output, transform.outputFactsFor(output));
    }
  }
  function notify(method: string, params: Record<string, unknown>) {
    const event = mapCodexAppServerNotification({ method, params: { threadId: 'native', turnId: 'turn', ...params } });
    assert.ok(event);
    const result = transformCodexEvent(event, 'codex61-sol', state);
    for (const message of Array.isArray(result) ? result : result ? [result] : []) emit(message);
  }
  function text(id: string, phase: string | undefined, content: string) {
    notify('item/started', { item: { id, type: 'agentMessage', text: '', phase } });
    notify('item/agentMessage/delta', { itemId: id, delta: content.slice(0, 2) });
    notify('item/agentMessage/delta', { itemId: id, delta: content.slice(2) });
    notify('item/completed', { item: { id, type: 'agentMessage', text: content, phase } });
  }
  return { projection, notify, text, emit };
}

test('streamed Codex process and final retain native channels and all text across a tool', () => {
  const { projection, text } = stream();
  text('process', 'commentary', '我先去读原件。');
  projection.tool({ id: 'tool', type: 'tool_use', label: 'Read', timestamp: 1, executionRef: 'child' });
  text('answer', 'final_answer', '原因已经查清。');
  const { content, layout } = projection.snapshot();
  assert.equal(content, '我先去读原件。\n\n原因已经查清。');
  assert.equal(layout.status, 'available');
  if (layout.status !== 'available') return;
  assert.deepEqual(
    layout.runs.map((run) => [run.identity.nativeId, run.channel]),
    [
      ['process', 'commentary'],
      ['answer', 'final'],
    ],
  );
  assert.deepEqual(
    layout.order.map((ref) => ref.kind),
    ['run', 'tool', 'run'],
  );
});

test('Codex may reveal its native phase only at completion, after provisional deltas', () => {
  const { projection, notify } = stream();
  notify('item/started', { item: { id: 'answer', type: 'agentMessage', text: '' } });
  notify('item/agentMessage/delta', { itemId: 'answer', delta: '答案\n{' });
  assert.equal(projection.snapshot().layout.status, 'unavailable');
  notify('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: '答案\n{完整}', phase: 'final_answer' },
  });
  assert.equal(projection.snapshot().content, '答案\n{完整}');
  assert.equal(projection.snapshot().layout.status, 'available');
});

test('missing Codex phase still leaves the complete streamed text readable without classification', () => {
  const { projection, text } = stream();
  text('unknown', undefined, '没有原生通道。');
  assert.equal(projection.snapshot().content, '没有原生通道。');
  assert.equal(projection.snapshot().layout.status, 'unavailable');
});

test('a rewritten native delta and completion replace their run without duplicating the visible answer', () => {
  const { projection, notify } = stream();
  const payload = '{"tool_uses":[{"recipient_name":"functions.shell","parameters":{}}]}';
  notify('item/agentMessage/delta', { itemId: 'answer', delta: '答案\n' });
  notify('item/agentMessage/delta', { itemId: 'answer', delta: payload });
  notify('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: `答案\n${payload}`, phase: 'final_answer' },
  });
  const { content, layout } = projection.snapshot();
  assert.equal(content, '答案');
  assert.equal(layout.status === 'unavailable' && layout.reason, 'content_changed');
});
