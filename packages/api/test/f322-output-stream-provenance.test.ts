import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';
import { mapCodexAppServerNotification } from '../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.js';
import {
  type CodexStreamState,
  finalizeCodexStream,
  transformCodexEvent,
} from '../src/domains/cats/services/agents/providers/codex-event-transform.js';
import { RoutingMessageOutputProjection } from '../src/domains/cats/services/agents/routing/message-output-projection.js';
import {
  createRoutingMessageTransform,
  toStoredToolEvent,
} from '../src/domains/cats/services/agents/routing/route-helpers.js';
import type { StoredToolEvent } from '../src/domains/cats/services/stores/ports/MessageStore.js';
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
function stream(initialState: Partial<CodexStreamState> = {}) {
  const state: CodexStreamState = { hadPriorTextTurn: false, ...initialState };
  const transform = createRoutingMessageTransform();
  const projection = new RoutingMessageOutputProjection({
    threadId: 'thread',
    catId: 'codex61-sol',
    turnInvocationId: 'child',
  });
  const tools: StoredToolEvent[] = [];
  function emit(message: AgentMessage) {
    for (const output of transform.transform(message)) {
      if (output.type === 'text') projection.text(output, transform.outputFactsFor(output));
      const tool = toStoredToolEvent(output, 'child');
      if (tool) {
        tools.push(tool);
        projection.tool(tool);
      }
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
  return { projection, notify, text, emit, tools, state };
}

for (const toolAfter of ['first delta', 'all deltas']) {
  test(`a production own-signature finalization remains single after a tool (${toolAfter})`, () => {
    const signature = '[小太阳/gpt-6.1-sol🐾]';
    const body = '结论一\n\n结论二';
    const { projection, notify, emit, state } = stream({ signatureIdentity: '小太阳', canonicalSignature: signature });
    notify('item/agentMessage/delta', { itemId: 'answer', delta: '结论一' });
    const tool = { id: 'pending', type: 'commandExecution', command: 'build', exitCode: 0, status: 'completed' };
    if (toolAfter === 'first delta') notify('item/completed', { item: tool });
    notify('item/agentMessage/delta', { itemId: 'answer', delta: `\n\n结论二\n\n${signature}` });
    if (toolAfter === 'all deltas') notify('item/completed', { item: tool });
    const completion = {
      item: { id: 'answer', type: 'agentMessage', text: `${body}\n\n${signature}`, phase: 'final_answer' },
    };
    notify('item/completed', completion);
    notify('item/completed', completion);
    assert.equal(projection.snapshot().content, body);
    notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    const tail = finalizeCodexStream(state, 'codex61-sol');
    assert.ok(tail);
    emit(tail);
    emit({ type: 'done', catId: 'codex61-sol', timestamp: 3 });
    assert.equal(projection.snapshot().content, `${body}\n\n${signature}`);
    assert.equal(projection.snapshot().layout.status, 'available');
  });
}

test('serialized completion metadata cannot assert a producer-only signature removal', () => {
  const signature = '[小太阳/gpt-6.1-sol🐾]';
  const body = '结论一\n\n结论二';
  const { projection, notify, emit, state } = stream({ signatureIdentity: '小太阳', canonicalSignature: signature });
  notify('item/agentMessage/delta', { itemId: 'answer', delta: `${body}\n\n${signature}` });
  projection.tool({ id: 'result', type: 'tool_result', executionRef: 'child', label: 'build', timestamp: 2 });
  const completion = transformCodexEvent(
    {
      type: 'item.completed',
      thread_id: 'native',
      turn_id: 'turn',
      item: { id: 'answer', type: 'agent_message', text: `${body}\n\n${signature}`, phase: 'final_answer' },
    },
    'codex61-sol',
    state,
  );
  assert.ok(completion && !Array.isArray(completion));
  // Even a same-named string field after JSON cannot borrow the private fact.
  emit(JSON.parse(JSON.stringify({ ...completion, nativeSignatureSuffix: `\n\n${signature}` })) as AgentMessage);
  const result = projection.snapshot();
  assert.equal(result.content, `${body}\n\n${signature}\n\n${body}`);
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});

test('the production command completion between Codex deltas preserves one complete native paragraph', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/f322-codex-interleaved-tool.json', import.meta.url), 'utf8'),
  ) as { events: { method: string; params: Record<string, unknown> }[] };
  const { projection, notify, text, tools } = stream();
  for (const event of fixture.events) notify(event.method, event.params);
  const completion = fixture.events.at(-1);
  assert.ok(completion);
  const expected = (completion.params.item as { text: string }).text;
  assert.equal(projection.snapshot().content, expected);
  assert.deepEqual(
    tools.map((tool) => tool.type),
    ['tool_use', 'tool_result'],
  );
  assert.equal(tools[0].toolUseId, tools[1].toolUseId);
  notify(completion.method, completion.params);
  assert.equal(projection.snapshot().content, expected, 'a repeated completion adds no second paragraph');
  text('final', 'final_answer', '后续核对继续。');
  const result = projection.snapshot();
  assert.equal(result.content, `${expected}\n后续核对继续。`);
  assert.equal(result.layout.status, 'available');
  if (result.layout.status !== 'available') return;
  assert.deepEqual(
    result.layout.order.map((ref) => ref.kind),
    ['tool', 'run', 'tool', 'run'],
  );
  assert.deepEqual(
    result.layout.order.flatMap((ref) => (ref.kind === 'tool' ? [ref.toolEventId] : [])),
    tools.map((tool) => tool.id),
  );
});

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
