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
});
