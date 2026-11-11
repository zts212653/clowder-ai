import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CatId } from '@cat-cafe/shared';
import { toStoredToolEvent } from '../src/domains/cats/services/agents/routing/route-helpers.js';

it('preserves the original input/output bounds and stores recall metadata separately for history', () => {
  const input = { path: 'x'.repeat(600) },
    meta = '<recall-meta>{"resultStatus":"counted","resultCount":1}</recall-meta>',
    content = 'actual result '.repeat(400) + '\n' + meta;
  const use = toStoredToolEvent(
    {
      type: 'tool_use',
      catId: 'codex' as CatId,
      toolName: 'read_file',
      toolInput: input,
      toolUseId: 'pair',
      timestamp: 1,
    },
    'turn',
  )!;
  const result = toStoredToolEvent(
    {
      type: 'tool_result',
      catId: 'codex' as CatId,
      toolInput: input,
      toolUseId: 'pair',
      toolResultStatus: 'error',
      content,
      timestamp: 2,
    },
    'turn',
  )!;
  const boundedInput = JSON.stringify(input).slice(0, 200) + '…';
  assert.equal(use.detail, boundedInput);
  assert.equal(use.inputDetail, undefined);
  assert.equal(use.toolName, 'read_file');
  assert.equal(result.detail, content.slice(0, 1500) + '…');
  assert.equal(result.inputDetail, boundedInput);
  assert.equal(result.resultMeta, meta);
  assert.equal(result.status, 'error');
  assert.equal(result.executionRef, use.executionRef);
  const absent = toStoredToolEvent({ type: 'tool_result', catId: 'codex' as CatId, timestamp: 3 }, 'turn')!;
  assert.equal(absent.resultMeta, undefined);
  assert.equal(absent.inputDetail, undefined);
});
