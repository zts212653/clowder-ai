import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createEvalHubRoot, writeEvalHubVerdict } from './eval-hub-corpus-fixture.js';

describe('F248 Phase B2 operator narrative projection', () => {
  it('turns an independent empty window into an insufficient-evidence card', (t) => {
    const repoHarnessFeedbackRoot = createEvalHubRoot(t);
    writeEvalHubVerdict(repoHarnessFeedbackRoot, {
      verdictId: 'fixture-anchor-first-empty-window',
      domainId: 'eval:anchor-first',
      featureId: 'F203',
      componentId: 'anchor-first',
      durationHours: 24,
      components: [
        {
          id: 'anchor-first',
          name: 'Fixture anchor',
          activationCounts: { observations: 0 },
          frictionCounts: {},
          confidence: 'low',
        },
      ],
    });
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: new Date('2026-07-09T19:27:00.000Z'),
    });
    const item = summary.items.find((candidate) => candidate.id === 'fixture-anchor-first-empty-window');

    assert.ok(item, 'independent empty-window verdict must be readable');
    assert.ok(item.operatorNarrative, 'read model must project one structured operator narrative');
    assert.equal(item.operatorNarrative.evidenceQuality, 'insufficient');
    assert.match(item.operatorNarrative.headline, /数据还不够/);
    assert.match(item.operatorNarrative.summary, /采样了 24 小时/);
    assert.match(item.operatorNarrative.action, /不用改代码/);
    // The live verdict corpus can publish a newer domain verdict after this
    // historical item. In that case the domain has a fresh next evaluation
    // window instead of remaining overdue, while the item's evidence quality
    // and operator action must stay unchanged.
    assert.match(item.operatorNarrative.nextCheck, /超过原定复评时间|下一轮积累/);
    assert.doesNotMatch(item.operatorNarrative.summary, /The selected|Track-2|keep_observe/);
    assert.equal('summaryForHuman' in item, false, 'broken string-only projection must be removed');
  });
});
