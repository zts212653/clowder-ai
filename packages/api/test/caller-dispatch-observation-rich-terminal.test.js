import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);

const scope = { ownerId: 'owner-1', threadId: 'thread-1', callerCatId: 'caller' };

function sourceFor(responseId) {
  return {
    id: 'source-rich',
    threadId: scope.threadId,
    userId: scope.ownerId,
    from: { kind: 'agent', catId: scope.callerCatId },
    content: 'inspect the artifact',
    timestamp: 1,
    lifecycle: {
      kind: 'input',
      orderKey: '1:source-rich',
      dispatchRefs: [{ targetId: 'worker', phase: 'settled', statusMessageId: responseId, dispatchedAt: 2 }],
    },
  };
}

function terminal(responseId, contentBlocks) {
  return {
    id: responseId,
    threadId: scope.threadId,
    userId: scope.ownerId,
    from: { kind: 'agent', catId: 'worker' },
    content: '',
    contentBlocks,
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: `2:${responseId}`,
      invocationId: 'inv-worker',
      targetId: 'worker',
      inputEntryIds: ['entry-rich'],
      inputMessageIds: ['source-rich'],
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
    },
  };
}

describe('caller dispatch rich terminal projection', () => {
  it('summarizes a rich-only terminal before consuming its observation', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const response = terminal('response-rich', [
      { type: 'image', url: '/uploads/result.png', alt: 'verification screenshot' },
      { type: 'file', url: '/uploads/report.pdf', fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 42 },
    ]);
    const source = sourceFor(response.id);
    const messages = new Map([
      [source.id, source],
      [response.id, response],
    ]);
    registry.registerPersistedSource(source, ['worker']);

    const projection = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);

    assert.match(projection.prompt, /completed/);
    assert.match(projection.prompt, /\[图片: verification screenshot\]/);
    assert.match(projection.prompt, /\[文件: report\.pdf\]/);
    assert.equal(projection.included[0]?.terminal, true);
    registry.acknowledge(projection.included);
    assert.equal(registry.list(scope).length, 0);
  });

  it('retains a terminal whose visible payload cannot be represented', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const response = terminal('response-tool-only', [
      { type: 'tool_result', toolId: 'tool-1', result: { secretStructuredResult: true } },
    ]);
    const source = sourceFor(response.id);
    const messages = new Map([
      [source.id, source],
      [response.id, response],
    ]);
    registry.registerPersistedSource(source, ['worker']);

    const projection = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);

    assert.match(projection.prompt, /unknown/);
    assert.doesNotMatch(projection.prompt, /secretStructuredResult/);
    assert.equal(projection.included[0]?.terminal, false);
    registry.acknowledge(projection.included);
    assert.equal(registry.list(scope).length, 1);
  });
});
