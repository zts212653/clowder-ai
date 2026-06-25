import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F236 AC-E3 — anchor-first live-verdict sunset signal tests.
 *
 * Asserts:
 *   - attribution findings include sunsetSignals per tool
 *   - severity escalates to 'high' when anchorTax fires
 *   - proposedAction = 'fix' for anchorTax tools (Signal ① only, blindness unconfirmed)
 *   - sunsetAssessment summary in attribution root
 *   - verdict.md renders sunset signal details
 *
 * TDD: written RED before sunset signal changes in eval-anchor-first-live-verdict.ts.
 */

const IMPORT_LIVE_VERDICT = '../../dist/infrastructure/harness-eval/anchor-first/eval-anchor-first-live-verdict.js';

const DOMAIN = {
  domainId: 'eval:anchor-first',
  displayName: 'Anchor-First Context Entry Eval',
  systemThreadId: 'thread_eval_anchor_first',
  evalCat: { catId: 'gpt52', handle: '@gpt52', model: 'gpt-5.4' },
  frequency: 'weekly',
  sourceAdapter: 'f236-anchor-telemetry-rollup',
  sourceRefsKind: 'anchor-telemetry-snapshot',
  threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: ['longitudinal-analysis'] },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F236', ownerCatId: 'opus-47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
  fixtures: [],
  enabled: true,
};

function stubPacket(overrides = {}) {
  return {
    id: 'vhp-anchor-first-lv-test',
    domainId: 'eval:anchor-first',
    createdAt: '2026-06-22T00:00:00.000Z',
    phenomenon: 'anchor-first telemetry rollup analysis',
    harnessUnderEval: {
      featureId: 'F236',
      componentId: 'anchor-telemetry-rollup',
      name: 'anchor-first preview/drill open-rate rollup',
    },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:anchor.open_rate'],
      sampleTraceRefs: ['trace:anchor-001'],
    },
    dailyTrend: { window: '168h', current: { c: 1 }, baseline: { c: 1 }, threshold: { c: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'anchor tax on thread-context', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F236', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-29T00:00:00.000Z', closureCondition: 'stable for a week' },
    counterarguments: ['could be sampling noise'],
    ...overrides,
  };
}

function stubSelector() {
  return {
    kind: 'anchor-telemetry-snapshot',
    windowStartMs: 1782000000000,
    windowEndMs: 1782086400000,
  };
}

/** Healthy tool: low open rate, positive netBenefit. */
function healthyToolStats() {
  return {
    previewResponses: 20,
    previewedItems: 50,
    drills: 5,
    drilledUniqueItems: 5,
    openRateByItem: 0.1, // 5/50
    returnedChars: 2000,
    originalChars: 10000,
    charsSaved: 8000,
    drillChars: 1000,
    netBenefit: 7000,
  };
}

/** Anchor-tax tool: high open rate AND net negative. */
function anchorTaxToolStats() {
  return {
    previewResponses: 15,
    previewedItems: 30,
    drills: 25,
    drilledUniqueItems: 25,
    openRateByItem: 0.833, // 25/30, > 0.8 threshold
    returnedChars: 5000,
    originalChars: 8000,
    charsSaved: 3000,
    drillChars: 6000,
    netBenefit: -3000, // negative: drill cost > savings
  };
}

/** High open rate but positive netBenefit (not full anchor tax). */
function highOpenRateToolStats() {
  return {
    previewResponses: 10,
    previewedItems: 20,
    drills: 17,
    drilledUniqueItems: 17,
    openRateByItem: 0.85, // > 0.8
    returnedChars: 3000,
    originalChars: 15000,
    charsSaved: 12000,
    drillChars: 4000,
    netBenefit: 8000, // still positive despite high drill rate
  };
}

/** Net negative but low open rate (partial anchor tax signal). */
function netNegativeToolStats() {
  return {
    previewResponses: 5,
    previewedItems: 10,
    drills: 3,
    drilledUniqueItems: 3,
    openRateByItem: 0.3, // low
    returnedChars: 4000,
    originalChars: 5000,
    charsSaved: 1000,
    drillChars: 3000,
    netBenefit: -2000, // negative but low open rate
  };
}

/** Would be anchorTax but too few samples to be reliable. */
function lowSampleAnchorTaxStats() {
  return {
    previewResponses: 3,
    previewedItems: 4, // < 10 → low sample
    drills: 4,
    drilledUniqueItems: 4,
    openRateByItem: 1.0, // 4/4 = 100%, would be > 0.8 threshold
    returnedChars: 500,
    originalChars: 800,
    charsSaved: 300,
    drillChars: 1000,
    netBenefit: -700, // negative — would trigger anchorTax if sample sufficient
  };
}

describe('F236 AC-E3 — anchor-first live verdict sunset signals', () => {
  let harnessFeedbackRoot;

  beforeEach(() => {
    harnessFeedbackRoot = join(tmpdir(), `anchor-first-lv-test-${Date.now()}`);
    mkdirSync(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
    mkdirSync(join(harnessFeedbackRoot, 'bundles'), { recursive: true });
  });

  afterEach(() => {
    if (harnessFeedbackRoot && existsSync(harnessFeedbackRoot)) {
      rmSync(harnessFeedbackRoot, { recursive: true, force: true });
    }
  });

  it('flags anchorTax when openRateByItem > 0.8 AND netBenefit < 0', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: {
        'thread-context': anchorTaxToolStats(),
        'pending-mentions': healthyToolStats(),
      },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-sunset-flags',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));
    const tcFinding = attribution.findings.find((f) => f.id.includes('thread-context'));
    const pmFinding = attribution.findings.find((f) => f.id.includes('pending-mentions'));

    // thread-context: anchorTax = true (high open rate + net negative)
    assert.ok(tcFinding.sunsetSignals, 'thread-context finding must have sunsetSignals');
    assert.equal(tcFinding.sunsetSignals.anchorTax, true);
    assert.equal(tcFinding.sunsetSignals.highOpenRate, true);
    assert.equal(tcFinding.sunsetSignals.netNegative, true);

    // pending-mentions: no sunset signals
    assert.ok(pmFinding.sunsetSignals, 'pending-mentions finding must have sunsetSignals');
    assert.equal(pmFinding.sunsetSignals.anchorTax, false);
    assert.equal(pmFinding.sunsetSignals.highOpenRate, false);
    assert.equal(pmFinding.sunsetSignals.netNegative, false);
  });

  it('escalates severity to high for anchorTax tools', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: {
        'thread-context': anchorTaxToolStats(),
        'pending-mentions': healthyToolStats(),
        'list-tasks': highOpenRateToolStats(),
      },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-severity-escalation',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));

    const tcFinding = attribution.findings.find((f) => f.id.includes('thread-context'));
    const pmFinding = attribution.findings.find((f) => f.id.includes('pending-mentions'));
    const ltFinding = attribution.findings.find((f) => f.id.includes('list-tasks'));

    // anchorTax (both signals) → high severity
    assert.equal(tcFinding.frictionSignal.severity, 'high');
    // healthy → low severity
    assert.equal(pmFinding.frictionSignal.severity, 'low');
    // high open rate only (no net negative) → medium severity (existing behavior)
    assert.equal(ltFinding.frictionSignal.severity, 'medium');
  });

  it('sets proposedAction to fix for anchorTax tools (Signal ① only, blindness unconfirmed)', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: {
        'thread-context': anchorTaxToolStats(),
        'pending-mentions': healthyToolStats(),
      },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-proposed-action',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));

    const tcFinding = attribution.findings.find((f) => f.id.includes('thread-context'));
    const pmFinding = attribution.findings.find((f) => f.id.includes('pending-mentions'));

    // VG fix: anchorTax = Signal ① only → 'fix' (not 'sunset')
    // Generator can't confirm Signal ② (blindness); eval cat escalates to delete_sunset
    assert.equal(tcFinding.proposedAction[0].action, 'fix');
    assert.equal(pmFinding.proposedAction[0].action, 'keep-observe');
  });

  it('includes sunsetAssessment summary in attribution root', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: {
        'thread-context': anchorTaxToolStats(),
        'pending-mentions': healthyToolStats(),
        'list-tasks': netNegativeToolStats(),
      },
      orphanDrills: 2,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-sunset-assessment',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));

    assert.ok(attribution.sunsetAssessment, 'must have sunsetAssessment summary');
    assert.equal(attribution.sunsetAssessment.toolCount, 3);
    assert.equal(attribution.sunsetAssessment.toolsWithAnchorTax, 1, 'only thread-context has both signals');
    assert.equal(attribution.sunsetAssessment.toolsNetNegative, 2, 'thread-context + list-tasks are net negative');
    assert.equal(attribution.sunsetAssessment.toolsHighOpenRate, 1, 'only thread-context has high open rate');
  });

  it('renders sunset signal section in verdict.md', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: { 'thread-context': anchorTaxToolStats() },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-md-sunset',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const md = readFileSync(artifact.path, 'utf8');
    assert.ok(md.includes('Sunset Signal'), 'verdict.md must have Sunset Signal section');
    assert.ok(md.includes('thread-context'), 'must mention the tool');
    assert.ok(md.includes('ANCHOR_TAX'), 'must flag anchor tax signal');
  });

  it('no sunset flags when all tools are healthy', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: {
        'pending-mentions': healthyToolStats(),
        'list-tasks': healthyToolStats(),
      },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-healthy',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));

    assert.equal(attribution.sunsetAssessment.toolsWithAnchorTax, 0);
    assert.equal(attribution.sunsetAssessment.toolsNetNegative, 0);
    assert.equal(attribution.sunsetAssessment.toolsHighOpenRate, 0);

    for (const finding of attribution.findings) {
      assert.equal(finding.sunsetSignals.anchorTax, false);
    }
  });

  it('distinguishes high-open-rate-only from full anchorTax', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: { 'thread-context': highOpenRateToolStats() },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-high-rate-only',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));
    const finding = attribution.findings[0];

    // High open rate but positive netBenefit → not full anchorTax
    assert.equal(finding.sunsetSignals.highOpenRate, true);
    assert.equal(finding.sunsetSignals.netNegative, false);
    assert.equal(finding.sunsetSignals.anchorTax, false);

    // severity stays medium (single signal, not high)
    assert.equal(finding.frictionSignal.severity, 'medium');
    // proposedAction = fix (single signal per AC-E3 spec mapping)
    assert.equal(finding.proposedAction[0].action, 'fix');
  });

  it('netNegative-only maps to fix action and medium severity (P1 review fix)', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: { 'thread-context': netNegativeToolStats() },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-net-negative-only',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));
    const finding = attribution.findings[0];

    // netNegative-only: single sunset signal
    assert.equal(finding.sunsetSignals.netNegative, true);
    assert.equal(finding.sunsetSignals.highOpenRate, false);
    assert.equal(finding.sunsetSignals.anchorTax, false);

    // single signal → medium severity, fix action (not keep-observe!)
    assert.equal(finding.frictionSignal.severity, 'medium');
    assert.equal(finding.proposedAction[0].action, 'fix');
  });

  it('low sample skips findings entirely — noFindingRecord + LOW_SAMPLE label (P2 R2 fix)', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: { 'thread-context': lowSampleAnchorTaxStats() },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-low-sample',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));

    // Low-sample tools should NOT appear in findings at all —
    // publish-policy treats findings[] as actionable (regular_pr).
    assert.equal(attribution.findings.length, 0);

    // noFindingRecord with reason=low_sample (drives evidence_only_interim_pr)
    assert.ok(attribution.noFindingRecord, 'must have noFindingRecord for all-low-sample rollup');
    assert.equal(attribution.noFindingRecord.reason, 'low_sample');

    // sunsetAssessment tracks low-sample count
    assert.equal(attribution.sunsetAssessment.lowSampleToolCount, 1);
    assert.equal(attribution.sunsetAssessment.toolsWithAnchorTax, 0);
    assert.equal(attribution.sunsetAssessment.toolsNetNegative, 0);
    assert.equal(attribution.sunsetAssessment.toolsHighOpenRate, 0);

    // Verdict markdown still shows LOW_SAMPLE for eval cat visibility
    const md = readFileSync(artifact.path, 'utf8');
    assert.ok(md.includes('LOW_SAMPLE'), 'low-sample tool must show LOW_SAMPLE label');
    assert.ok(!md.includes('HEALTHY'), 'low-sample tool must not be labeled HEALTHY');
  });

  it('mixed rollup: sufficient-sample tools in findings, low-sample tools skipped', async () => {
    const { generateAnchorFirstLiveVerdict } = await import(IMPORT_LIVE_VERDICT);

    const rollup = {
      perTool: {
        'thread-context': anchorTaxToolStats(), // sufficient sample (30 items)
        'list-tasks': lowSampleAnchorTaxStats(), // low sample (4 items)
      },
      orphanDrills: 0,
      track1Snapshot: { returnedByTool: {}, returnedCharsByTool: {}, drillByTool: {}, drillCharsByTool: {} },
    };

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: 'test-mixed-sample',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollup,
      selector: stubSelector(),
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-22T12:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));

    // Only sufficient-sample tool in findings
    assert.equal(attribution.findings.length, 1);
    assert.ok(attribution.findings[0].id.includes('thread-context'));

    // No noFindingRecord (there ARE actionable findings)
    assert.equal(attribution.noFindingRecord, undefined);

    // sunsetAssessment shows both counts
    assert.equal(attribution.sunsetAssessment.toolCount, 1);
    assert.equal(attribution.sunsetAssessment.lowSampleToolCount, 1);
  });
});
