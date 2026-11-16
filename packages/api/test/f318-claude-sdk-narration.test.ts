import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { transformClaudeEvent } from '../src/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import { RoutingMessageOutputProjection } from '../src/domains/cats/services/agents/routing/message-output-projection.js';
import { createRoutingMessageTransform } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';

const CAT = createCatId('opus');
const PURPOSE = '这张车票用来预览 demo 主画面。';
const ANSWER = '候选图已经发上来了。';
const thinking = (text: string) => ({ type: 'thinking', thinking: text, signature: 'opaque' });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { id, content },
  ...extra,
});
const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event, thinking_display: 'updates' });

function parse(events: unknown[]) {
  const state: Parameters<typeof transformClaudeEvent>[2] = {
    currentMessageId: undefined,
    partialTextMessageIds: new Set<string>(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
  return events.flatMap((event) => {
    const result = transformClaudeEvent(event, CAT, state);
    return Array.isArray(result) ? result : result ? [result] : [];
  });
}

// Captures the 2026-11-13 incident's wire shape, without private prompts, tool
// inputs or signatures. The snapshot indexes its OWN content[0]; the streamed
// block was index 1. Claude sends the snapshot before content_block_stop.
function narrationFrames() {
  return [
    stream({ type: 'message_start', message: { id: 'progress' } }),
    stream({ type: 'content_block_start', index: 0, content_block: thinking('') }),
    assistant('progress', [thinking('')]),
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'content_block_start', index: 1, content_block: thinking('') }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: PURPOSE.slice(0, 5) } }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: PURPOSE.slice(5) } }),
    assistant('progress', [thinking(PURPOSE)], { narration_block_indexes: [0], thinking_display: 'updates' }),
    stream({ type: 'content_block_stop', index: 1 }),
    assistant('progress', [{ type: 'tool_use', id: 'read', name: 'Bash', input: {} }]),
    stream({ type: 'message_stop' }),
    assistant('answer', [{ type: 'text', text: ANSWER }]),
  ];
}

test('a provider-tagged narration survives the streamed thinking / snapshot / tool sequence once', () => {
  const output = parse(narrationFrames());
  assert.equal(output.find((event) => event.type === 'text')?.textSource, 'provider_summary');
  assert.equal(
    output
      .filter((event) => event.type === 'text')
      .map((event) => event.content)
      .join(''),
    `${PURPOSE}\n\n${ANSWER}`,
  );
  assert.equal(
    output.findIndex((event) => event.type === 'text') < output.findIndex((event) => event.type === 'tool_use'),
    true,
  );
});

test('snapshot-only narration uses frame-local indexes and preserves mixed block order', () => {
  const output = parse([
    assistant(
      'mixed',
      [
        thinking('Private reasoning'),
        thinking(PURPOSE),
        { type: 'tool_use', id: 'read', name: 'Bash', input: {} },
        { type: 'text', text: ANSWER },
      ],
      { narration_block_indexes: [1] },
    ),
  ]);
  assert.deepEqual(
    output.map((event) => [event.type, event.content ?? event.toolName]),
    [
      ['text', PURPOSE],
      ['tool_use', 'Bash'],
      ['text', ANSWER],
    ],
  );
});

test('unlisted, empty and invalidly indexed thinking never becomes public prose', () => {
  for (const indexes of [undefined, [], [1], [-1], ['0'], [0.5], '0']) {
    const output = parse([
      assistant('private', [thinking('Private reasoning')], {
        narration_block_indexes: indexes,
        thinking_display: 'updates',
      }),
    ]);
    assert.equal(
      output.some((event) => event.type === 'text'),
      false,
      `indexes=${JSON.stringify(indexes)}`,
    );
    assert.equal(output[0]?.type, 'system_info');
  }
  assert.equal(
    parse([assistant('empty', [thinking('')], { narration_block_indexes: [0] })]).some(
      (event) => event.type === 'text',
    ),
    false,
  );
});

test('regular text deltas do not suppress separately annotated narration in the same message', () => {
  const output = parse([
    stream({ type: 'message_start', message: { id: 'mixed' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开头。' } }),
    assistant('mixed', [thinking(PURPOSE)], { narration_block_indexes: [0] }),
    assistant('mixed', [{ type: 'text', text: '开头。' }]),
  ]);
  assert.equal(
    output
      .filter((event) => event.type === 'text')
      .map((event) => event.content)
      .join(''),
    `开头。${PURPOSE}`,
  );
});

test('the official SDK carrier passes narration through the production output projection', async () => {
  const service = new ClaudeSdkAgentService({
    catId: CAT,
    model: 'claude-opus-5-5',
    mcpServerPath: '',
    l0CompilerFn: async () => 'identity',
    runtimeResolver: claudeSdkRuntimeFixture,
    queryFn: ({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const first = await prompt[Symbol.asyncIterator]().next();
        yield { type: 'system', subtype: 'init', session_id: 'native-session' };
        yield assistant('skill', [{ type: 'tool_use', id: 'skill', name: 'Skill', input: {} }]);
        yield* narrationFrames();
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          session_id: 'native-session',
          user_message_uuids: [first.value?.uuid],
          queued_turn_count: 0,
        };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      },
      close() {},
    }),
  });
  const projection = new RoutingMessageOutputProjection({ threadId: 'thread', catId: CAT, turnInvocationId: 'turn' });
  const transform = createRoutingMessageTransform();
  const events: AgentMessage[] = [];
  for await (const event of service.invoke('Explain the ticket, then use a tool.', { workingDirectory: '/tmp' })) {
    events.push(event);
    for (const output of transform.transform(event)) {
      if (output.type === 'text') projection.text(output, transform.outputFactsFor(output));
    }
  }
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(projection.snapshot().content, `${PURPOSE}\n\n${ANSWER}`);
});
