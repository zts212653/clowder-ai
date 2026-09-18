import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { deriveStructuredTraceAnnotations } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/structured-rule-tagger.js'
);

function episode(resultDetail) {
  return {
    summary: {
      turnId: 'turn-1',
      threadId: 'thread-1',
      userId: 'owner-1',
      catId: 'cat-1',
      timestamp: 100,
      segments: [],
    },
    terminal: {
      traceTurnId: 'turn-1',
      invocationId: 'inv-1',
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      catId: 'cat-1',
      inputMessageId: 'input-1',
      outputMessageId: 'output-1',
      terminalAt: 200,
      terminalKind: 'completed',
      toolCalls: [
        {
          toolName: 'cat_cafe_post_message',
          callId: 'call-1',
          outcome: 'error',
          resultDetail,
        },
      ],
    },
  };
}

describe('F257 structured rule tagger', () => {
  test('explicit tool/schema validation errors annotate S13 without semantic guessing', () => {
    const annotations = deriveStructuredTraceAnnotations(
      episode('Invalid arguments: required property targetCats was not provided'),
    );
    assert.equal(annotations.length, 1);
    assert.deepEqual(
      {
        source: annotations[0].source,
        objectiveId: annotations[0].objectiveId,
        metricId: annotations[0].metricId,
        unitRefs: annotations[0].unitRefs,
        polarity: annotations[0].polarity,
      },
      {
        source: 'structured-rule',
        objectiveId: 'tool-access-correct-use',
        metricId: 'tool-schema-failure-count',
        unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
        polarity: 'counterexample',
      },
    );
  });

  test('generic runtime errors remain unclassified for periodic semantic analysis', () => {
    assert.deepEqual(deriveStructuredTraceAnnotations(episode('network timeout while contacting remote service')), []);
  });
});
