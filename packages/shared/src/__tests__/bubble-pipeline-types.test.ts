import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUBBLE_EVENT_TYPES, BUBBLE_KINDS, isBubbleEventType, isBubbleKind } from '../types/bubble-pipeline.js';

describe('F183 Bubble pipeline shared contract', () => {
  it('exports ADR-033 BubbleEvent 14-class vocabulary in order', () => {
    assert.deepEqual(BUBBLE_EVENT_TYPES, [
      'local_placeholder_created',
      'stream_started',
      'stream_chunk',
      'thinking_chunk',
      'tool_event',
      'cli_output',
      'rich_block',
      'callback_final',
      'history_hydrate',
      'draft_restore',
      'cache_restore',
      'done',
      'error',
      'timeout',
    ]);
  });

  it('exports ADR-033 BubbleKind 5-class vocabulary in order', () => {
    assert.deepEqual(BUBBLE_KINDS, ['assistant_text', 'thinking', 'tool_or_cli', 'rich_block', 'system_status']);
  });

  it('guards BubbleEvent strings', () => {
    assert.equal(isBubbleEventType('stream_chunk'), true);
    assert.equal(isBubbleEventType('assistant_text'), false);
    assert.equal(isBubbleEventType('unknown'), false);
    assert.equal(isBubbleEventType(null), false);
  });

  it('guards BubbleKind strings', () => {
    assert.equal(isBubbleKind('assistant_text'), true);
    assert.equal(isBubbleKind('stream_chunk'), false);
    assert.equal(isBubbleKind('unknown'), false);
    assert.equal(isBubbleKind(undefined), false);
  });
});
