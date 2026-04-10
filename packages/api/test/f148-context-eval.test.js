// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { extractContextEvalSignals } = await import('../dist/domains/cats/services/agents/routing/context-eval.js');

/** Helper: minimal CoverageMap */
function makeCoverageMap(overrides = {}) {
  return {
    omitted: { count: 15, timeRange: { from: 1712000000000, to: 1712003600000 }, participants: ['opus', 'codex'] },
    burst: { count: 6, timeRange: { from: 1712003600000, to: 1712004000000 } },
    anchorIds: ['a1', 'a2'],
    threadMemory: { available: true, sessionsIncorporated: 3, decisions: ['use Redis 6398'], openQuestions: [] },
    retrievalHints: ['search_evidence("redis")'],
    ...overrides,
  };
}

describe('F148 OQ-2: extractContextEvalSignals', () => {
  test('returns all required fields with complete inputs', () => {
    const signals = extractContextEvalSignals({
      coverageMap: makeCoverageMap(),
      toolNames: ['search_evidence', 'post_message', 'get_thread_context'],
      responseTokenEstimate: 2400,
    });

    assert.equal(typeof signals.selfServeRetrievalCount, 'number');
    assert.equal(typeof signals.toolCallCount, 'number');
    assert.equal(typeof signals.responseTokenEstimate, 'number');
    assert.equal(typeof signals.burstCount, 'number');
    assert.equal(typeof signals.omittedCount, 'number');
    assert.equal(typeof signals.anchorCount, 'number');
    assert.equal(typeof signals.hadThreadMemory, 'boolean');
    assert.equal(typeof signals.retrievalHintCount, 'number');
  });

  test('counts self-serve retrieval tools correctly', () => {
    const signals = extractContextEvalSignals({
      coverageMap: makeCoverageMap(),
      toolNames: [
        'mcp__cat-cafe__cat_cafe_search_evidence',
        'post_message',
        'cat_cafe_get_thread_context',
        'search_evidence',
        'create_rich_block',
      ],
      responseTokenEstimate: 1000,
    });

    assert.equal(signals.selfServeRetrievalCount, 3, 'should count search_evidence (2) + get_thread_context (1)');
    assert.equal(signals.toolCallCount, 5, 'should count all tools');
  });

  test('handles zero tool calls', () => {
    const signals = extractContextEvalSignals({
      coverageMap: makeCoverageMap(),
      toolNames: [],
      responseTokenEstimate: 500,
    });

    assert.equal(signals.selfServeRetrievalCount, 0);
    assert.equal(signals.toolCallCount, 0);
  });

  test('extracts coverageMap summary fields', () => {
    const signals = extractContextEvalSignals({
      coverageMap: makeCoverageMap({
        anchorIds: ['a1', 'a2', 'a3'],
        threadMemory: { available: true, sessionsIncorporated: 5 },
        retrievalHints: ['h1', 'h2', 'h3'],
      }),
      toolNames: [],
      responseTokenEstimate: 800,
    });

    assert.equal(signals.burstCount, 6);
    assert.equal(signals.omittedCount, 15);
    assert.equal(signals.anchorCount, 3);
    assert.equal(signals.hadThreadMemory, true);
    assert.equal(signals.retrievalHintCount, 3);
  });

  test('handles null threadMemory', () => {
    const signals = extractContextEvalSignals({
      coverageMap: makeCoverageMap({ threadMemory: null }),
      toolNames: [],
      responseTokenEstimate: 100,
    });

    assert.equal(signals.hadThreadMemory, false);
  });

  test('passes through responseTokenEstimate', () => {
    const signals = extractContextEvalSignals({
      coverageMap: makeCoverageMap(),
      toolNames: [],
      responseTokenEstimate: 4200,
    });

    assert.equal(signals.responseTokenEstimate, 4200);
  });
});
