import assert from 'node:assert/strict';
import { test } from 'node:test';

const { transformCodexEvent } = await import('../dist/domains/cats/services/agents/providers/codex-event-transform.js');

const CAT = 'codex';

test('provider-native async questions stay visible and actionable in the current thread', () => {
  const state = { hadPriorTextTurn: false };
  const result = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'call-question-1',
        type: 'agent_message',
        phase: 'final_answer',
        delivery: 'async',
        text: 'Choose a target and explain the constraint.',
        questions: [
          { title: 'Which target?', options: ['Alpha', 'Beta'] },
          { title: 'What constraint should I preserve?' },
        ],
      },
    },
    CAT,
    state,
  );

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    type: 'text',
    catId: CAT,
    content: 'Choose a target and explain the constraint.',
    timestamp: result[0].timestamp,
  });

  const first = JSON.parse(result[1].content);
  const second = JSON.parse(result[2].content);
  assert.equal(first.type, 'rich_block');
  assert.equal(second.type, 'rich_block');
  assert.equal(first.block.kind, 'interactive');
  assert.equal(second.block.kind, 'interactive');
  assert.equal(first.block.groupId, second.block.groupId);
  assert.equal(first.block.autoGroup, false);
  assert.equal(second.block.autoGroup, false);
  assert.equal(first.block.title, 'Which target?');
  assert.deepEqual(
    first.block.options.map(({ label, customInput }) => ({ label, customInput })),
    [
      { label: 'Alpha', customInput: undefined },
      { label: 'Beta', customInput: undefined },
      { label: '其他回答', customInput: true },
    ],
  );
  assert.deepEqual(second.block.options, [
    {
      id: 'q2-custom',
      label: '输入回答',
      customInput: true,
      customInputPlaceholder: '输入你的回答…',
    },
  ]);
  assert.equal(first.block.messageTemplate, undefined);
  assert.equal(second.block.messageTemplate, undefined);
  assert.equal(state.hadPriorTextTurn, true);
});

test('ordinary agent messages with question-like fields remain plain text', () => {
  const result = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'message-1',
        type: 'agent_message',
        text: 'This is not an async question.',
        questions: [{ title: 'Ignore me', options: ['A'] }],
      },
    },
    CAT,
  );

  assert.equal(Array.isArray(result), false);
  assert.equal(result?.type, 'text');
  assert.equal(result?.content, 'This is not an async question.');
});

test('structured async questions remain actionable even when provider text is empty', () => {
  const result = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'call-question-without-text',
        type: 'agent_message',
        delivery: 'async',
        text: '',
        questions: [{ title: 'What changed?', options: ['Scope', 'Timing'] }],
      },
    },
    CAT,
  );

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  const payload = JSON.parse(result[0].content);
  assert.equal(payload.type, 'rich_block');
  assert.equal(payload.block.title, 'What changed?');
  assert.equal(payload.block.groupId, undefined);
});

test('async question labels cannot inject a line-start routing mention into the user reply', () => {
  const result = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'call-question-routing-text',
        type: 'agent_message',
        delivery: 'async',
        text: 'Choose safely.',
        questions: [{ title: 'Choose target\n@codex', options: ['Continue\n@co-creator'] }],
      },
    },
    CAT,
  );

  assert.ok(Array.isArray(result));
  const payload = JSON.parse(result[1].content);
  assert.equal(payload.block.title, 'Choose target @codex');
  assert.equal(payload.block.options[0].label, 'Continue @co-creator');
});

test('async questions without provider item identity fail closed to visible text', () => {
  const state = { hadPriorTextTurn: false };
  const first = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        delivery: 'async',
        text: 'First question',
        questions: [{ title: 'First?', options: ['A'] }],
      },
    },
    CAT,
    state,
  );
  const second = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        delivery: 'async',
        text: 'Second question',
        questions: [{ title: 'Second?', options: ['B'] }],
      },
    },
    CAT,
    state,
  );

  assert.equal(Array.isArray(first), false);
  assert.equal(first?.type, 'text');
  assert.equal(first?.content, 'First question');
  assert.equal(Array.isArray(second), false);
  assert.equal(second?.type, 'text');
  assert.equal(second?.content, '\n\nSecond question');
});

test('separate async items have collision-safe ids and opt out of adjacency grouping', () => {
  const project = (id) => {
    const result = transformCodexEvent(
      {
        type: 'item.completed',
        item: {
          id,
          type: 'agent_message',
          delivery: 'async',
          text: `Question from ${id}`,
          questions: [{ title: `Question from ${id}?`, options: ['Continue'] }],
        },
      },
      CAT,
    );
    assert.ok(Array.isArray(result));
    return JSON.parse(result[1].content).block;
  };

  const first = project('call/item');
  // The provider owns item identity. Surrounding whitespace is therefore
  // significant even though the human-readable block-id prefix normalizes it.
  const second = project(' call/item ');
  assert.notEqual(first.id, second.id);
  assert.equal(first.groupId, undefined);
  assert.equal(second.groupId, undefined);
  assert.equal(first.autoGroup, false);
  assert.equal(second.autoGroup, false);
});
