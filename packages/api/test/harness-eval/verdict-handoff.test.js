import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
} from '../../dist/infrastructure/harness-eval/verdict-handoff.js';

const basePacket = {
  id: 'vhp_eval_a2a_2026_05_21_001',
  domainId: 'eval:a2a',
  createdAt: '2026-05-21T20:00:00.000Z',
  phenomenon: 'route-serial verdict hints increased above baseline',
  harnessUnderEval: {
    featureId: 'F167',
    componentId: 'C2',
    name: 'forced-pass guard',
  },
  evidencePacket: {
    snapshotRefs: ['fixture:snapshot-F167-day9'],
    attributionRefs: ['fixture:attribution-F167-day9'],
    metricRefs: ['cat_cafe_a2a_c2_verdict_without_pass_count'],
    sampleTraceRefs: ['trace:f167-c2-day9'],
  },
  dailyTrend: {
    window: '24h',
    current: { verdictWithoutPass: 9 },
    baseline: { verdictWithoutPass: 2 },
    threshold: { verdictWithoutPass: 5 },
    direction: 'regressed',
  },
  rootCauseHypothesis: {
    summary: 'C2 is firing because author messages include verdict language without line-start handoff.',
    confidence: 'medium',
    alternatives: ['thread context compression hid the prior pass', 'tool telemetry duplicated one span'],
  },
  verdict: 'fix',
  ownerAsk: {
    targetFeatureId: 'F167',
    targetOwnerCatId: 'opus47',
    requestedAction: 'Inspect C2 forced-pass wording and decide whether the guard needs stricter handoff hints.',
  },
  acceptanceReevalPlan: {
    nextEvalAt: '2026-05-22T20:00:00.000Z',
    closureCondition: 'next eval shows verdictWithoutPass <= threshold for 24h',
  },
  counterarguments: ['If traces are duplicated, this should be dismissed after dedupe verification.'],
};

describe('Verdict Handoff Packet contract', () => {
  it('accepts a complete packet with the required contract sections', () => {
    const packet = parseVerdictHandoffPacket(basePacket);

    assert.equal(packet.domainId, 'eval:a2a');
    assert.equal(packet.verdict, 'fix');
    assert.equal(assertCanCrossThreadHandoff(packet).ok, true);
  });

  it('accepts ISO timestamps with timezone offsets', () => {
    const packet = parseVerdictHandoffPacket({
      ...basePacket,
      createdAt: '2026-05-21T20:00:00+08:00',
      acceptanceReevalPlan: {
        ...basePacket.acceptanceReevalPlan,
        nextEvalAt: '2026-05-22T20:00:00+08:00',
      },
    });

    assert.equal(packet.createdAt, '2026-05-21T20:00:00+08:00');
    assert.equal(packet.acceptanceReevalPlan.nextEvalAt, '2026-05-22T20:00:00+08:00');
  });

  it('rejects a packet missing counterarguments', () => {
    const { counterarguments: _counterarguments, ...missingCounterarguments } = basePacket;
    assert.throws(() => parseVerdictHandoffPacket(missingCounterarguments), /counterarguments/);
  });

  it('rejects a packet missing acceptance / re-eval plan', () => {
    const { acceptanceReevalPlan: _acceptanceReevalPlan, ...missingPlan } = basePacket;
    assert.throws(() => parseVerdictHandoffPacket(missingPlan), /acceptanceReevalPlan/);
  });

  it('rejects cross-thread handoff when evidence refs are empty', () => {
    const packet = parseVerdictHandoffPacket({
      ...basePacket,
      evidencePacket: {
        snapshotRefs: [],
        attributionRefs: [],
        metricRefs: [],
        sampleTraceRefs: [],
      },
    });

    const decision = assertCanCrossThreadHandoff(packet);
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /evidence/);
  });

  it('rejects delete/sunset without an explicit operator accept gate', () => {
    assert.throws(
      () =>
        parseVerdictHandoffPacket({
          ...basePacket,
          verdict: 'delete_sunset',
          ownerAsk: {
            ...basePacket.ownerAsk,
            requestedAction: 'Sunset the C2 guard.',
          },
          acceptanceReevalPlan: {
            ...basePacket.acceptanceReevalPlan,
            closureCondition: 'owner says this can be removed',
          },
        }),
      /operator/,
    );
  });

  it('rejects delete/sunset when operator accept is only mentioned as not required', () => {
    assert.throws(
      () =>
        parseVerdictHandoffPacket({
          ...basePacket,
          verdict: 'delete_sunset',
          ownerAsk: {
            ...basePacket.ownerAsk,
            requestedAction: 'Sunset the C2 guard; no operator accept required for this cleanup.',
          },
          acceptanceReevalPlan: {
            ...basePacket.acceptanceReevalPlan,
            closureCondition: 'next eval confirms no regression after sunset.',
          },
        }),
      /operator/,
    );
  });

  it('accepts delete/sunset when operator accept is explicit', () => {
    const packet = parseVerdictHandoffPacket({
      ...basePacket,
      verdict: 'delete_sunset',
      governance: {
        cvoAcceptRequired: true,
      },
      ownerAsk: {
        ...basePacket.ownerAsk,
        requestedAction: 'Prepare sunset plan; requires operator accept before disabling the guard.',
      },
      acceptanceReevalPlan: {
        ...basePacket.acceptanceReevalPlan,
        closureCondition: 'operator accept is recorded, then next eval confirms no regression after sunset.',
      },
    });

    assert.equal(packet.verdict, 'delete_sunset');
  });
});
