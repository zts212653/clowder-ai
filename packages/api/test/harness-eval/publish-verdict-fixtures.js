/**
 * F192 Phase H publish-verdict shared test fixtures.
 * Extracted from publish-verdict.test.js per AGENTS.md 350-line hard limit.
 */

/**
 * Build a valid VerdictHandoffPacket with override-able fields.
 * Mirrors verdictHandoffPacketSchema shape; tests override specific fields
 * to exercise validation edges.
 */
export function buildPacket(overrides = {}) {
  return {
    id: 'vhp-test-001',
    domainId: 'eval:a2a',
    createdAt: '2026-06-05T11:00:00.000Z',
    phenomenon: 'Test phenomenon for Phase H',
    harnessUnderEval: { featureId: 'F167', componentId: 'C1', name: 'test-component' },
    evidencePacket: {
      snapshotRefs: ['snapshot:bundle/test/snapshot'],
      attributionRefs: ['attribution:bundle/test/finding-001'],
      metricRefs: ['metric:c1.test'],
      sampleTraceRefs: ['trace:test-001'],
    },
    dailyTrend: {
      window: '24h',
      current: { 'c1.test': 5 },
      baseline: { 'c1.test': 2 },
      threshold: { 'c1.test': 10 },
      direction: 'regressed',
    },
    rootCauseHypothesis: {
      summary: 'Test hypothesis',
      confidence: 'medium',
      alternatives: ['alt-1'],
    },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F167', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-12T11:00:00.000Z', closureCondition: 'no friction' },
    counterarguments: ['counter-1'],
    ...overrides,
  };
}
