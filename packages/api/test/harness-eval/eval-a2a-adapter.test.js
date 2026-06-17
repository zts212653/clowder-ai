import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildA2aVerdictHandoff } from '../../dist/infrastructure/harness-eval/a2a/eval-a2a-adapter.js';

const domain = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  systemThreadId: 'thread_eval_a2a',
  evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
  frequency: 'daily',
  sourceAdapter: 'f167-runtime-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['harness-fit-digest'],
  handoffTargetResolver: { featureId: 'F167', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
};

const snapshot = {
  featureId: 'F167',
  generatedAt: '2026-05-21T20:00:00.000Z',
  window: { startMs: 1779300000000, endMs: 1779386400000, durationHours: 24 },
  components: [
    {
      componentId: 'C2',
      componentName: 'forced-pass guard',
      activationCounts: { 'c2.verdict_hint_emitted': 20 },
      frictionCounts: { 'c2.verdict_without_pass_count': 9 },
      telemetryGaps: [],
      confidence: 'medium',
      falsePositiveCandidates: [],
      bypassCandidates: [],
    },
  ],
};

const attributionReport = {
  featureId: 'F167',
  evalSnapshotId: 'eval-F167-2026-05-21',
  generatedAt: '2026-05-21T20:01:00.000Z',
  findings: [
    {
      id: 'AR-2026-05-21-001',
      relatedFeature: 'F167',
      frictionSignal: {
        type: 'c2.verdict_without_pass_count',
        severity: 'medium',
        confidence: 0.7,
        detectedAt: '2026-05-21T20:01:00.000Z',
      },
      attribution: {
        primaryLayer: 'harness_misfit',
        pipelineOrHuman: 'pipeline',
        evidence: [
          {
            type: 'counter',
            anchor: 'C2/c2.verdict_without_pass_count',
            excerpt: 'c2.verdict_without_pass_count=9 exceeds threshold',
          },
        ],
      },
      proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'forced-pass hint rate is high' }],
      status: 'open',
    },
  ],
};

describe('eval:a2a adapter', () => {
  it('converts F167 snapshot and attribution finding into a complete handoff packet', () => {
    const packet = buildA2aVerdictHandoff({ domain, snapshot, attributionReport });

    assert.equal(packet.domainId, 'eval:a2a');
    assert.equal(packet.verdict, 'fix');
    assert.equal(packet.harnessUnderEval.componentId, 'C2');
    assert.ok(packet.evidencePacket.snapshotRefs.length > 0);
    assert.ok(packet.evidencePacket.attributionRefs.length > 0);
    assert.ok(packet.ownerAsk.requestedAction.length > 0);
  });

  it('maps observability add-counter findings to build verdicts', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot,
      attributionReport: {
        ...attributionReport,
        findings: [
          {
            ...attributionReport.findings[0],
            id: 'AR-2026-05-21-build',
            frictionSignal: {
              ...attributionReport.findings[0].frictionSignal,
              type: 'observability-gap',
            },
            attribution: {
              ...attributionReport.findings[0].attribution,
              primaryLayer: 'tool_gap',
              evidence: [
                {
                  type: 'telemetry-gap',
                  anchor: 'C2/c2.verdict_without_pass_count',
                  excerpt: 'missing verdict_without_pass counter prevents reliable eval',
                },
              ],
            },
            proposedAction: [
              {
                action: 'add-counter',
                target: 'C2/c2.verdict_without_pass_count',
                rationale: 'instrument the missing C2 counter',
              },
            ],
          },
        ],
      },
    });

    assert.equal(packet.verdict, 'build');
    assert.match(packet.ownerAsk.requestedAction, /Build/);
  });

  it('maps sunset findings to delete_sunset verdicts with a operator gate', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot,
      attributionReport: {
        ...attributionReport,
        findings: [
          {
            ...attributionReport.findings[0],
            id: 'AR-2026-05-21-sunset',
            frictionSignal: {
              ...attributionReport.findings[0].frictionSignal,
              type: 'l3.intent_regex_false_positive',
            },
            proposedAction: [
              {
                action: 'sunset-harness',
                target: 'C2/l3-intent-regex',
                rationale: 'regex guard now misclassifies legitimate handoffs',
              },
            ],
          },
        ],
      },
    });

    assert.equal(packet.verdict, 'delete_sunset');
    assert.deepEqual(packet.governance, { cvoAcceptRequired: true });
    assert.match(packet.ownerAsk.requestedAction, /sunset/i);
  });

  it('rejects mismatched snapshot and attribution feature ids', () => {
    assert.throws(
      () =>
        buildA2aVerdictHandoff({
          domain,
          snapshot,
          attributionReport: {
            ...attributionReport,
            featureId: 'F192',
          },
        }),
      /feature identity mismatch: snapshot=F167 attribution=F192 target=F167/,
    );
  });

  it('rejects mismatched registry handoff target feature id', () => {
    assert.throws(
      () =>
        buildA2aVerdictHandoff({
          domain: {
            ...domain,
            handoffTargetResolver: {
              ...domain.handoffTargetResolver,
              featureId: 'F192',
            },
          },
          snapshot,
          attributionReport,
        }),
      /F167/,
    );
  });

  it('uses unique packet ids for multiple same-day handoffs', () => {
    const firstPacket = buildA2aVerdictHandoff({ domain, snapshot, attributionReport });
    const secondPacket = buildA2aVerdictHandoff({
      domain,
      snapshot,
      attributionReport: {
        ...attributionReport,
        generatedAt: '2026-05-21T20:05:00.000Z',
        findings: [
          {
            ...attributionReport.findings[0],
            id: 'AR-2026-05-21-002',
            frictionSignal: {
              ...attributionReport.findings[0].frictionSignal,
              type: 'c2.verdict_hint_forced_pass_count',
            },
            attribution: {
              ...attributionReport.findings[0].attribution,
              evidence: [
                {
                  type: 'counter',
                  anchor: 'C2/c2.verdict_hint_forced_pass_count',
                  excerpt: 'c2.verdict_hint_forced_pass_count=5 exceeds threshold',
                },
              ],
            },
          },
        ],
      },
    });

    assert.notEqual(firstPacket.id, secondPacket.id);
  });

  it('computes re-eval deadline from handoff creation time', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot,
      attributionReport: {
        ...attributionReport,
        generatedAt: '2026-05-23T09:30:00.000Z',
      },
    });

    assert.equal(packet.acceptanceReevalPlan.nextEvalAt, '2026-05-26T09:30:00.000Z');
  });

  it('chooses the strongest finding when multiple findings are present', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot: {
        ...snapshot,
        components: [
          {
            componentId: 'C1',
            componentName: 'routing contract',
            activationCounts: { 'c1.route_seen': 8 },
            frictionCounts: { 'c1.shadow_miss': 1 },
            telemetryGaps: [],
            confidence: 'medium',
            falsePositiveCandidates: [],
            bypassCandidates: [],
          },
          ...snapshot.components,
        ],
      },
      attributionReport: {
        ...attributionReport,
        findings: [
          {
            ...attributionReport.findings[0],
            id: 'AR-2026-05-21-low',
            frictionSignal: {
              ...attributionReport.findings[0].frictionSignal,
              type: 'c1.shadow_miss',
              severity: 'low',
              confidence: 0.9,
            },
            attribution: {
              ...attributionReport.findings[0].attribution,
              evidence: [
                {
                  type: 'counter',
                  anchor: 'C1/c1.shadow_miss',
                  excerpt: 'c1.shadow_miss=1 exceeds low threshold',
                },
              ],
            },
          },
          {
            ...attributionReport.findings[0],
            id: 'AR-2026-05-21-high',
            frictionSignal: {
              ...attributionReport.findings[0].frictionSignal,
              severity: 'high',
              confidence: 0.7,
            },
          },
        ],
      },
    });

    assert.equal(packet.harnessUnderEval.componentId, 'C2');
    assert.deepEqual(packet.evidencePacket.attributionRefs, ['attribution:AR-2026-05-21-high']);
  });

  it('matches finding evidence anchors by exact component-id boundary', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot: {
        ...snapshot,
        components: [
          {
            componentId: 'C1',
            componentName: 'routing contract',
            activationCounts: { 'c1.route_seen': 8 },
            frictionCounts: { 'c1.shadow_miss': 1 },
            telemetryGaps: [],
            confidence: 'medium',
            falsePositiveCandidates: [],
            bypassCandidates: [],
          },
          {
            componentId: 'C10',
            componentName: 'routing follow-up contract',
            activationCounts: { 'c10.route_seen': 8 },
            frictionCounts: { 'c10.shadow_miss': 6 },
            telemetryGaps: [],
            confidence: 'medium',
            falsePositiveCandidates: [],
            bypassCandidates: [],
          },
        ],
      },
      attributionReport: {
        ...attributionReport,
        findings: [
          {
            ...attributionReport.findings[0],
            frictionSignal: {
              ...attributionReport.findings[0].frictionSignal,
              type: 'c10.shadow_miss',
            },
            attribution: {
              ...attributionReport.findings[0].attribution,
              evidence: [
                {
                  type: 'counter',
                  anchor: 'C10/c10.shadow_miss',
                  excerpt: 'c10.shadow_miss=6 exceeds threshold',
                },
              ],
            },
          },
        ],
      },
    });

    assert.equal(packet.harnessUnderEval.componentId, 'C10');
    assert.equal(packet.harnessUnderEval.name, 'routing follow-up contract');
  });

  it('refuses to fallback to the first component when finding evidence has no component anchor', () => {
    assert.throws(
      () =>
        buildA2aVerdictHandoff({
          domain,
          snapshot: {
            ...snapshot,
            components: [
              {
                componentId: 'C1',
                componentName: 'routing contract',
                activationCounts: { 'c1.route_seen': 8 },
                frictionCounts: { 'c1.shadow_miss': 1 },
                telemetryGaps: [],
                confidence: 'medium',
                falsePositiveCandidates: [],
                bypassCandidates: [],
              },
              ...snapshot.components,
            ],
          },
          attributionReport: {
            ...attributionReport,
            findings: [
              {
                ...attributionReport.findings[0],
                attribution: {
                  ...attributionReport.findings[0].attribution,
                  evidence: [
                    {
                      type: 'counter',
                      anchor: 'snapshot:global-friction-total',
                      excerpt: 'global friction total exceeds threshold',
                    },
                  ],
                },
              },
            ],
          },
        }),
      /component anchor/,
    );
  });

  it('uses a later component evidence anchor after a global evidence ref', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot: {
        ...snapshot,
        components: [
          {
            componentId: 'C1',
            componentName: 'routing contract',
            activationCounts: { 'c1.route_seen': 8 },
            frictionCounts: { 'c1.shadow_miss': 1 },
            telemetryGaps: [],
            confidence: 'medium',
            falsePositiveCandidates: [],
            bypassCandidates: [],
          },
          ...snapshot.components,
        ],
      },
      attributionReport: {
        ...attributionReport,
        findings: [
          {
            ...attributionReport.findings[0],
            attribution: {
              ...attributionReport.findings[0].attribution,
              evidence: [
                {
                  type: 'counter',
                  anchor: 'snapshot:global-friction-total',
                  excerpt: 'global friction total exceeds threshold',
                },
                {
                  type: 'counter',
                  anchor: 'C2/c2.verdict_without_pass_count',
                  excerpt: 'c2.verdict_without_pass_count=9 exceeds threshold',
                },
              ],
            },
          },
        ],
      },
    });

    assert.equal(packet.harnessUnderEval.componentId, 'C2');
  });

  it('maps clean attribution report to keep_observe', () => {
    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot,
      attributionReport: {
        ...attributionReport,
        findings: [],
        noFindingRecord: { reason: 'clean', evidence: 'all healthy' },
      },
    });

    assert.equal(packet.verdict, 'keep_observe');
    assert.match(packet.phenomenon, /No actionable/);
  });

  it('uses an evidence-bearing component for clean keep_observe packets', () => {
    const cleanSnapshot = {
      ...snapshot,
      components: [
        {
          componentId: 'L1',
          componentName: 'wake signal capture',
          activationCounts: { 'l1.wake_seen': 42 },
          frictionCounts: {},
          telemetryGaps: [],
          confidence: 'high',
          falsePositiveCandidates: [],
          bypassCandidates: [],
        },
        ...snapshot.components,
      ],
    };

    const packet = buildA2aVerdictHandoff({
      domain,
      snapshot: cleanSnapshot,
      attributionReport: {
        ...attributionReport,
        findings: [],
        noFindingRecord: { reason: 'clean', evidence: 'no actionable F167 finding in current window' },
      },
    });

    assert.equal(packet.verdict, 'keep_observe');
    assert.equal(packet.harnessUnderEval.componentId, 'C2');
    assert.deepEqual(packet.evidencePacket.metricRefs, ['c2.verdict_without_pass_count']);
  });

  it('refuses to emit a packet when evidence refs are empty', () => {
    assert.throws(
      () =>
        buildA2aVerdictHandoff({
          domain,
          snapshot: { ...snapshot, components: [] },
          attributionReport,
        }),
      /evidence/,
    );
  });
});
