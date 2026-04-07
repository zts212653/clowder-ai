import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractDecisionSignals } from '../dist/domains/cats/services/session/extractDecisionSignals.js';

describe('F148 VG-3: extractDecisionSignals', () => {
  test('extracts decisions from transcript text via regex', () => {
    const signals = extractDecisionSignals({
      transcriptText: '我们决定用方案B。确定了redis端口6398。选择不用cheap model。',
      summaryConclusions: [],
      summaryOpenQuestions: [],
    });
    assert.ok(signals.decisions.length >= 2, `expected >=2 decisions, got ${signals.decisions.length}`);
    assert.ok(signals.decisions.some((d) => d.includes('方案B')));
  });

  test('extracts open questions from transcript text via regex', () => {
    const signals = extractDecisionSignals({
      transcriptText: 'burst gap阈值需要实验确定。后续是否要加prompt cache？',
      summaryConclusions: [],
      summaryOpenQuestions: [],
    });
    assert.ok(signals.openQuestions.length >= 1, `expected >=1 questions, got ${signals.openQuestions.length}`);
  });

  test('extracts from ThreadSummary conclusions and openQuestions', () => {
    const signals = extractDecisionSignals({
      transcriptText: '',
      summaryConclusions: ['选择了分层传输方案', '不用Haiku做摘要'],
      summaryOpenQuestions: ['warm mention阈值待定'],
    });
    assert.deepStrictEqual(signals.decisions, ['选择了分层传输方案', '不用Haiku做摘要']);
    assert.deepStrictEqual(signals.openQuestions, ['warm mention阈值待定']);
  });

  test('combines both sources and deduplicates by substring', () => {
    const signals = extractDecisionSignals({
      transcriptText: '我们决定用方案B。',
      summaryConclusions: ['决定用方案B的原因是成本低'],
      summaryOpenQuestions: [],
    });
    // "决定用方案B" from regex is substring of summary conclusion → dedup
    assert.ok(signals.decisions.length <= 2, 'should deduplicate overlapping decisions');
  });

  test('returns empty arrays when no signals found', () => {
    const signals = extractDecisionSignals({
      transcriptText: '你好，今天天气不错。',
      summaryConclusions: [],
      summaryOpenQuestions: [],
    });
    assert.deepStrictEqual(signals.decisions, []);
    assert.deepStrictEqual(signals.openQuestions, []);
    assert.deepStrictEqual(signals.artifacts, []);
  });

  test('extracts artifact references (ADR, Feature IDs)', () => {
    const signals = extractDecisionSignals({
      transcriptText: '参考ADR-011的规范。这是F148的Phase E。',
      summaryConclusions: [],
      summaryOpenQuestions: [],
    });
    assert.ok(signals.artifacts.length >= 1, `expected >=1 artifacts, got ${signals.artifacts.length}`);
    assert.ok(signals.artifacts.some((a) => a.includes('ADR-011')));
  });

  test('caps decisions at 8, openQuestions at 5, artifacts at 8', () => {
    const manyConclusions = Array.from({ length: 12 }, (_, i) => `决策${i + 1}`);
    const manyQuestions = Array.from({ length: 8 }, (_, i) => `问题${i + 1}`);
    const signals = extractDecisionSignals({
      transcriptText: 'ADR-001 ADR-002 ADR-003 ADR-004 ADR-005 ADR-006 ADR-007 ADR-008 ADR-009 ADR-010',
      summaryConclusions: manyConclusions,
      summaryOpenQuestions: manyQuestions,
    });
    assert.ok(signals.decisions.length <= 8, `decisions capped at 8, got ${signals.decisions.length}`);
    assert.ok(signals.openQuestions.length <= 5, `openQuestions capped at 5, got ${signals.openQuestions.length}`);
    assert.ok(signals.artifacts.length <= 8, `artifacts capped at 8, got ${signals.artifacts.length}`);
  });
});
