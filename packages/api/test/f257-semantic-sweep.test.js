import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { SemanticSweepService } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/SemanticSweepService.js'
);

function episode(index) {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-1',
      catId: 'cat-1',
      timestamp: 100 + index,
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalTokenEstimate: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    },
    terminal: {
      traceTurnId: `turn-${index}`,
      invocationId: `inv-${index}`,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      catId: 'cat-1',
      inputMessageId: `input-${index}`,
      outputMessageId: `output-${index}`,
      terminalAt: 200 + index,
      terminalKind: 'completed',
      toolCalls: [],
    },
  };
}

describe('F257 periodic semantic sweep', () => {
  test('classifies only scheduler-selected unowned episodes and writes unified annotations', async () => {
    const episodes = new Map([
      ['inv-1', episode(1)],
      ['inv-2', episode(2)],
      ['inv-3', episode(3)],
    ]);
    const classified = [];
    const traceStore = {
      async listUnclassifiedInvocationIds() {
        return ['inv-1', 'inv-2', 'inv-3'];
      },
      async getEpisodeByInvocationId(invocationId) {
        return episodes.get(invocationId) ?? null;
      },
      async markEpisodeClassified(ownerUserId, invocationId) {
        classified.push([ownerUserId, invocationId]);
      },
    };
    const annotations = [];
    const seenContexts = [];
    const service = new SemanticSweepService({
      traceStore,
      annotationSink: {
        async append(annotation) {
          annotations.push(annotation);
          return { outcome: 'created', annotationId: annotation.annotationId, unitEvaluationReady: true };
        },
      },
      catalog: { registry: { registryVersion: 2, evaluationModels: [], objectives: [] }, manifest: { units: [] } },
      async hydrateContext(item) {
        return {
          episode: item,
          inputText: `input:${item.terminal.inputMessageId}`,
          outputText: `output:${item.terminal.outputMessageId}`,
        };
      },
      evaluator: {
        async evaluate({ contexts }) {
          seenContexts.push(...contexts);
          return [
            {
              invocationId: 'inv-1',
              status: 'matched',
              matches: [
                {
                  objectiveId: 'knowledge-evidence-quality',
                  metricId: 'unsupported-external-claim-count',
                  unitRefs: [{ unitType: 'segment', unitId: 'D20' }],
                  polarity: 'counterexample',
                  confidence: 0.86,
                  explanation: 'External claim has no cited source.',
                },
              ],
            },
            { invocationId: 'inv-2', status: 'irrelevant', matches: [] },
            // inv-3 intentionally omitted: it remains queued for retry.
          ];
        },
      },
    });

    const result = await service.run({ ownerUserId: 'owner-1', startMs: 0, endMs: 1000 });
    assert.deepEqual(result, { selected: 3, classified: 2, annotations: 1, unitEvaluationReady: true });
    assert.equal(seenContexts.length, 3);
    assert.equal(seenContexts[0].outputText, 'output:output-1');
    assert.deepEqual(classified, [
      ['owner-1', 'inv-1'],
      ['owner-1', 'inv-2'],
    ]);
    assert.deepEqual(
      {
        source: annotations[0].source,
        objectiveId: annotations[0].objectiveId,
        metricId: annotations[0].metricId,
        unitRefs: annotations[0].unitRefs,
      },
      {
        source: 'semantic-sweep',
        objectiveId: 'knowledge-evidence-quality',
        metricId: 'unsupported-external-claim-count',
        unitRefs: [{ unitType: 'segment', unitId: 'D20' }],
      },
    );
  });

  test('malformed evaluator output fails closed and leaves episodes unclassified', async () => {
    const classified = [];
    const service = new SemanticSweepService({
      traceStore: {
        async listUnclassifiedInvocationIds() {
          return ['inv-1'];
        },
        async getEpisodeByInvocationId() {
          return episode(1);
        },
        async markEpisodeClassified(_owner, invocationId) {
          classified.push(invocationId);
        },
      },
      annotationSink: { async append() {} },
      catalog: { registry: { registryVersion: 2, evaluationModels: [], objectives: [] }, manifest: { units: [] } },
      async hydrateContext(item) {
        return { episode: item, inputText: null, outputText: null };
      },
      evaluator: {
        async evaluate() {
          return [{ invocationId: 'inv-1', status: 'matched', matches: [] }];
        },
      },
    });

    await assert.rejects(service.run({ ownerUserId: 'owner-1', startMs: 0, endMs: 1000 }), /matched_without_matches/);
    assert.deepEqual(classified, []);
  });
});
