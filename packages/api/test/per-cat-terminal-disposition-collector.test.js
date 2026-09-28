import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { PerCatTerminalDispositionCollector } = await import(
  '../dist/domains/cats/services/agents/invocation/PerCatTerminalDispositionCollector.js'
);

describe('PerCatTerminalDispositionCollector', () => {
  it('records an unambiguous bare done as success', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['opus'] });

    collector.observe({ type: 'done', catId: 'opus' });

    assert.deepEqual(collector.getSuccessfulCatIds(), ['opus']);
  });

  it('keeps error then bare done disqualified', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['codex'] });

    collector.observe({ type: 'error', catId: 'codex' });
    collector.observe({ type: 'done', catId: 'codex' });

    assert.deepEqual(collector.getSuccessfulCatIds(), []);
  });

  it('revokes an earlier done when a terminal error follows', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['codex'] });

    collector.observe({ type: 'done', catId: 'codex' });
    collector.observe({ type: 'error', catId: 'codex' });

    assert.deepEqual(collector.getSuccessfulCatIds(), []);
  });

  it('rejects error-coded done and exact canceled tombstones', () => {
    const canceled = new Set(['codex']);
    const collector = new PerCatTerminalDispositionCollector({
      targetCatIds: ['codex', 'opus', 'gpt52'],
      isCanceled: (catId) => canceled.has(catId),
    });

    collector.observe({ type: 'done', catId: 'codex' });
    collector.observe({ type: 'done', catId: 'opus', errorCode: 'blocked' });
    collector.observe({ type: 'done', catId: 'gpt52' });

    assert.deepEqual(collector.getSuccessfulCatIds(), ['gpt52']);
  });

  it('keeps the immutable target domain when an A2A worklist grows', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['opus'] });

    collector.observe({ type: 'done', catId: 'opus' });
    collector.observe({ type: 'done', catId: 'gpt52' });

    assert.deepEqual(collector.getSuccessfulCatIds(), ['opus']);
  });

  it('allows a marked transient diagnostic to precede a successful done', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['opus'] });

    collector.observe({ type: 'error', catId: 'opus', errorDisposition: 'transient' });
    collector.observe({ type: 'done', catId: 'opus' });

    assert.deepEqual(collector.getSuccessfulCatIds(), ['opus']);
  });

  it('retains all adopted sources under their exact children across repeated done frames', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['codex'] });
    const first = {
      kind: 'managed_hold_continued',
      sourceMessageId: 'source-1',
      taskId: 'task-1',
      transition: 'reheld',
    };
    const second = { ...first, sourceMessageId: 'source-2', taskId: 'task-2' };
    const next = { ...first, sourceMessageId: 'source-3', taskId: 'task-3' };
    collector.observe({ type: 'done', catId: 'codex', invocationId: 'child-1', turnCustodyTerminalWitness: first });
    collector.observe({
      type: 'done',
      catId: 'codex',
      invocationId: 'child-1',
      turnCustodyTerminalWitness: first,
      turnCustodyTerminalWitnesses: [first, second],
    });
    collector.observe({ type: 'done', catId: 'codex', invocationId: 'child-2', turnCustodyTerminalWitnesses: [next] });
    assert.deepEqual(collector.getTerminalConsumptionByInvocationId(), {
      'child-1': [first, second],
      'child-2': [next],
    });
    assert.deepEqual(collector.getTerminalInvocationIdByCatId(), { codex: 'child-2' });
  });

  it('does not turn malformed, unbound or nonterminal event payloads into custody evidence', () => {
    const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['codex'] });
    const witness = { kind: 'managed_hold_continued', sourceMessageId: 'source', taskId: 'task', transition: 'reheld' };
    collector.observe({ type: 'text', catId: 'codex', invocationId: 'child', turnCustodyTerminalWitness: witness });
    collector.observe({ type: 'done', catId: 'codex', turnCustodyTerminalWitness: witness });
    collector.observe({ type: 'done', catId: 'codex', invocationId: 42, turnCustodyTerminalWitness: witness });
    collector.observe({
      type: 'done',
      catId: 'codex',
      invocationId: 'child',
      turnCustodyTerminalWitnesses: [
        { ...witness, sourceMessageId: '' },
        { ...witness, taskId: '' },
        { ...witness, transition: 'guessed' },
      ],
    });
    assert.deepEqual(collector.getTerminalConsumptionByInvocationId(), {});
  });
});
