import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLiveVerdictMarkdown } from '../../dist/infrastructure/harness-eval/a2a/eval-a2a-verdict-renderer.js';

const packet = {
  id: 'vhp-f168',
  verdict: 'keep_observe',
  phenomenon: 'External cases have traffic and no invariant violations.',
  harnessUnderEval: {
    featureId: 'F168',
    componentId: 'external-case-closure',
    name: 'External Case Closure',
  },
  ownerAsk: { requestedAction: 'Keep observing.' },
  acceptanceReevalPlan: {
    closureCondition: 'Two real cases close without a user nudge',
    nextEvalAt: '2026-07-21T00:00:00.000Z',
  },
  evidencePacket: {
    snapshotRefs: ['snapshot:bundle/f168/snapshot'],
    attributionRefs: ['attribution:bundle/f168/no-finding'],
    metricRefs: [],
    sampleTraceRefs: [],
  },
  counterarguments: ['One case is not enough for sunset.'],
};

describe('A2A-shaped verdict renderer domain binding', () => {
  it('renders the requested domain and feature instead of hard-coding eval:a2a/F167', () => {
    const markdown = formatLiveVerdictMarkdown('f168-verdict', packet, 'snapshot:bundle/f168/snapshot', {
      domainId: 'eval:external-case-closure',
      featureId: 'F168',
    });

    assert.match(markdown, /feature_ids: \[F192, F168\]/);
    assert.match(markdown, /domain_id: eval:external-case-closure/);
    assert.doesNotMatch(markdown, /domain_id: eval:a2a/);
  });
});
