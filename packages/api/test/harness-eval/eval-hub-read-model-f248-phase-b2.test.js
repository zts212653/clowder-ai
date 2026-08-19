import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

describe('F248 Phase B2 operator narrative projection', () => {
  it('turns the committed anchor-first empty window into an insufficient-evidence card', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: new Date('2026-07-09T19:27:00.000Z'),
    });
    const item = summary.items.find(
      (candidate) => candidate.id === '2026-06-28-eval-anchor-first-empty-window-keep-observe',
    );

    assert.ok(item, 'committed anchor-first empty-window verdict must remain readable');
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
