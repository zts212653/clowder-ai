import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { metricRefKeyCandidates } from '@cat-cafe/shared';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

describe('F248 B3 production metric glossary coverage', () => {
  it('requires every enabled production domain to expose a metric glossary', () => {
    const summary = loadEvalHubSummary({ harnessFeedbackRoot: repoHarnessFeedbackRoot });
    const missing = summary.domains
      .filter((domain) => domain.enabled && !domain.metricGlossary)
      .map((domain) => domain.domainId);

    assert.deepEqual(missing, [], `enabled production domains need a metric glossary:\n${missing.join('\n')}`);
  });

  it('explains every metric referenced by each enabled domain latest verdict', () => {
    const summary = loadEvalHubSummary({ harnessFeedbackRoot: repoHarnessFeedbackRoot });
    const missing = [];

    for (const domain of summary.domains) {
      if (!domain.enabled || !domain.latestVerdictId) continue;
      const latest = summary.items.find((item) => item.id === domain.latestVerdictId);
      assert.ok(latest, `${domain.domainId} latest verdict must be present in summary.items`);
      for (const ref of latest.evidence.metricRefs) {
        const candidates = metricRefKeyCandidates(ref);
        if (!candidates.some((key) => domain.metricGlossary?.[key])) {
          missing.push(`${domain.domainId}: ${ref}`);
        }
      }
    }

    assert.deepEqual(missing, [], `current production metric refs need human glossary entries:\n${missing.join('\n')}`);
  });

  it('keeps the current eval:memory verdict fully explainable without freezing its metric count', () => {
    const summary = loadEvalHubSummary({ harnessFeedbackRoot: repoHarnessFeedbackRoot });
    const memory = summary.domains.find((domain) => domain.domainId === 'eval:memory');
    assert.ok(memory?.latestVerdictId, 'eval:memory must expose a latest verdict');
    const latest = summary.items.find((item) => item.id === memory.latestVerdictId);
    assert.ok(latest, 'eval:memory latest verdict must be present');
    assert.ok(latest.evidence.metricRefs.length > 0, 'eval:memory latest verdict must publish metric evidence');
    for (const ref of latest.evidence.metricRefs) {
      const candidates = metricRefKeyCandidates(ref);
      assert.ok(
        candidates.some((key) => memory.metricGlossary?.[key]),
        `eval:memory metric needs a human glossary entry: ${ref}`,
      );
    }
    assert.equal(memory.metricGlossary?.search_zero_hit_count?.label, '零结果搜索数');
  });
});
