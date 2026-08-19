import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F287 memory cue MCP tools', () => {
  it('exposes only opaque handle, request id and enum outcome inputs', async () => {
    const { createMemoryCueTools, drillMemoryCueInputSchema, recordMemoryCueOutcomeInputSchema } = await import(
      '../dist/tools/memory-cue-tools.js'
    );
    const calls = [];
    const callbackPost = async (path, body) => {
      calls.push({ path, body });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    };
    const toolset = createMemoryCueTools(callbackPost);

    assert.deepEqual(
      toolset.tools.map((tool) => tool.name),
      ['cat_cafe_drill_memory_cue', 'cat_cafe_record_memory_cue_outcome'],
    );
    assert.deepEqual(Object.keys(drillMemoryCueInputSchema).sort(), ['clientRequestId', 'handle']);
    assert.deepEqual(Object.keys(recordMemoryCueOutcomeInputSchema).sort(), ['clientRequestId', 'handle', 'outcome']);
    for (const forbidden of [
      'ownerUserId',
      'threadId',
      'invocationId',
      'anchor',
      'revision',
      'sourceBody',
      'rationale',
    ]) {
      assert.equal(Object.hasOwn(drillMemoryCueInputSchema, forbidden), false);
      assert.equal(Object.hasOwn(recordMemoryCueOutcomeInputSchema, forbidden), false);
    }

    await toolset.handleDrillMemoryCue({ handle: 'opaque-handle', clientRequestId: 'drill-1' });
    await toolset.handleRecordMemoryCueOutcome({
      handle: 'opaque-handle',
      outcome: 'dismissed',
      clientRequestId: 'outcome-1',
    });
    assert.deepEqual(calls, [
      {
        path: '/api/callbacks/memory-cues/drill',
        body: { handle: 'opaque-handle', requestId: 'drill-1' },
      },
      {
        path: '/api/callbacks/memory-cues/outcome',
        body: { handle: 'opaque-handle', outcome: 'dismissed', requestId: 'outcome-1' },
      },
    ]);
  });

  it('documents the owner-bound drill and content-free outcome boundaries', async () => {
    const { createMemoryCueTools } = await import('../dist/tools/memory-cue-tools.js');
    const toolset = createMemoryCueTools(async () => ({ content: [] }));
    const drill = toolset.tools.find((tool) => tool.name === 'cat_cafe_drill_memory_cue');
    const outcome = toolset.tools.find((tool) => tool.name === 'cat_cafe_record_memory_cue_outcome');

    assert.match(drill.description, /owner-authenticated/i);
    assert.match(drill.description, /current source revision/i);
    assert.match(drill.description, /not for.*raw/i);
    assert.match(outcome.description, /applied.*dismissed/i);
    assert.match(outcome.description, /no rationale/i);
    assert.match(outcome.description, /presented/i);
  });
});
