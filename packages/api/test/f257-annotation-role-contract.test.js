import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  counterexampleWakeKey,
  isEvaluationPriorityAnnotation,
  isEvaluationPriorityCounterexample,
  isReplayableStructuredAnnotation,
} = await import('../dist/infrastructure/harness-eval/trace-annotation/high-confidence-annotation.js');

const annotation = (overrides = {}) => ({
  annotationId: 'annotation-1',
  episodeRef: { invocationId: 'inv-1' },
  source: 'mcp-marker',
  ruleId: 'mcp-marker',
  objectiveId: 'objective-1',
  metricId: 'metric-1',
  unitRefs: [],
  polarity: 'counterexample',
  confidence: 1,
  incidentKey: 'incident-1',
  evidenceRefs: [],
  createdAt: 1,
  ...overrides,
});

describe('F257 annotation roles stay separate', () => {
  test('MCP candidate is a priority hint but never replayable exact evidence', () => {
    const candidate = annotation({ polarity: 'candidate', confidence: 0.6 });
    assert.equal(isEvaluationPriorityAnnotation(candidate), true);
    assert.equal(isEvaluationPriorityCounterexample(candidate), false);
    assert.equal(isReplayableStructuredAnnotation(candidate), false);
  });

  test('structured exact evidence is replayable and a counterexample wake signal', () => {
    const structured = annotation({ source: 'structured-rule', ruleId: 'rule-1' });
    assert.equal(isReplayableStructuredAnnotation(structured), true);
    assert.equal(isEvaluationPriorityCounterexample(structured), true);
    assert.equal(counterexampleWakeKey(structured), 'structured:incident-1');
  });

  test('structured source without exact confidence is neither replayable nor a wake signal', () => {
    const inferred = annotation({ source: 'structured-rule', ruleId: 'rule-1', confidence: 0.6 });
    assert.equal(isReplayableStructuredAnnotation(inferred), false);
    assert.equal(isEvaluationPriorityAnnotation(inferred), false);
    assert.equal(isEvaluationPriorityCounterexample(inferred), false);
    assert.equal(counterexampleWakeKey(inferred), null);
  });

  test('MCP wake keys collapse multiple metrics in one invocation', () => {
    const first = annotation({ metricId: 'metric-a', incidentKey: 'incident-a' });
    const second = annotation({ metricId: 'metric-b', incidentKey: 'incident-b' });
    assert.equal(counterexampleWakeKey(first), counterexampleWakeKey(second));
    assert.equal(counterexampleWakeKey(first), 'mcp:objective-1:inv-1');
  });

  test('semantic-sweep history remains audit-only', () => {
    const historical = annotation({ source: 'semantic-sweep' });
    assert.equal(isEvaluationPriorityAnnotation(historical), false);
    assert.equal(isEvaluationPriorityCounterexample(historical), false);
    assert.equal(counterexampleWakeKey(historical), null);
  });
});
