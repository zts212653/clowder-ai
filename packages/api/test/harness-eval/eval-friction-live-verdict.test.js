import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F245 Phase C PR1b — eval-friction live-verdict file-writer tests (L3).
 *
 * Mirrors sop-generator-adapter.test.js's live-verdict block. Asserts:
 *   - verdict.md has live-verdict frontmatter (feedback_type / domain_id:eval:friction / packet_id)
 *   - bundle dir has snapshot.json + attribution.json + provenance.json + raw rollup report
 *   - snapshot conforms to a2a bundle schema (evalSnapshotId / window.durationHours /
 *     components[].id+name) and resolveA2aEvidenceBundle accepts it
 *   - refs use canonical snapshot:bundle/ + attribution:bundle/ prefixes
 *
 * TDD: imports from dist; written RED before eval-friction-live-verdict.ts exists.
 */

const IMPORT_LIVE_VERDICT = '../../dist/infrastructure/harness-eval/friction/eval-friction-live-verdict.js';

const DOMAIN = {
  domainId: 'eval:friction',
  displayName: 'Friction Signal Eval',
  systemThreadId: 'thread_eval_friction',
  evalCat: { catId: 'gpt52', handle: '@gpt52', model: 'gpt-5.4' },
  frequency: 'weekly',
  sourceAdapter: 'f245-friction-rollup',
  sourceRefsKind: 'friction-rollup-snapshot',
  threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: ['longitudinal-analysis'] },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F245', ownerCatId: 'opus-47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
  fixtures: [],
  enabled: true,
};

function stubPacket(overrides = {}) {
  return {
    id: 'vhp-friction-lv-test',
    domainId: 'eval:friction',
    createdAt: '2026-06-20T00:00:00.000Z',
    phenomenon: 'friction clusters surfaced in the weekly window',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['metric:friction.cluster_count'],
      sampleTraceRefs: ['trace:friction-001'],
    },
    dailyTrend: { window: '168h', current: { c: 1 }, baseline: { c: 1 }, threshold: { c: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'tool_gap on workspace-navigator', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F245', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-27T00:00:00.000Z', closureCondition: 'stable for a week' },
    counterarguments: ['could be sampling noise'],
    ...overrides,
  };
}

/** Build a FrictionRollupInput with N clusters (one signal each) over a known window. */
function stubRollupInput({ clusters = 1, degraded = false } = {}) {
  const signals = [];
  const clusterList = [];
  for (let i = 0; i < clusters; i++) {
    const id = `clu${i}`;
    const signalId = `paw-feel:m${i}#0`;
    signals.push({
      id: signalId,
      channel: 'paw-feel',
      timestamp: '2026-06-19T00:00:00.000Z',
      tool: `tool-${i}`,
      symptom: `symptom ${i}`,
      rawRef: `m${i}#0`,
      severity: i === 0 ? 'high' : 'low',
    });
    clusterList.push({
      clusterId: id,
      representative: `symptom ${i}`,
      channels: ['paw-feel'],
      count: 1,
      members: [{ signalId, rawRef: `m${i}#0`, channel: 'paw-feel' }],
      method: 'rule',
    });
  }
  return {
    window: { sinceMs: 1_780_000_000_000, untilMs: 1_780_600_000_000 },
    signals,
    clusters: clusterList,
    degraded,
    droppedChannels: [],
  };
}

const SELECTOR = {
  kind: 'friction-rollup-snapshot',
  windowStartMs: 1_780_000_000_000,
  windowEndMs: 1_780_600_000_000,
};

describe('generateFrictionLiveVerdict', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `friction-lv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes verdict.md + bundle (snapshot/attribution/provenance + raw report) — clusters present', async () => {
    const { generateFrictionLiveVerdict } = await import(IMPORT_LIVE_VERDICT);
    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    const verdictId = 'vhp-friction-lv-test';
    const result = generateFrictionLiveVerdict({
      verdictId,
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollupInput: stubRollupInput({ clusters: 2 }),
      selector: SELECTOR,
      submittedPacket: stubPacket(),
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    // verdict.md frontmatter
    assert.ok(existsSync(result.path), 'verdict.md should exist');
    const md = readFileSync(result.path, 'utf8');
    assert.ok(md.startsWith('---\n'), 'verdict.md must start with YAML frontmatter');
    assert.match(md, /feedback_type: live-verdict/);
    assert.match(md, /domain_id: eval:friction/);
    assert.match(md, /packet_id: vhp-friction-lv-test/);
    assert.match(md, /keep_observe/);

    // bundle files
    assert.ok(existsSync(result.bundleDir), 'bundle dir should exist');
    assert.ok(existsSync(join(result.bundleDir, 'snapshot.json')));
    assert.ok(existsSync(join(result.bundleDir, 'attribution.json')));
    assert.ok(existsSync(join(result.bundleDir, 'provenance.json')));
    // raw rollup report under bundle/raw (task-outcome shape — Decision 2)
    assert.ok(existsSync(join(result.bundleDir, 'raw', 'rollup-report.json')), 'raw rollup report must be written');
    const rawReport = JSON.parse(readFileSync(join(result.bundleDir, 'raw', 'rollup-report.json'), 'utf8'));
    assert.ok(Array.isArray(rawReport.report.actionableCandidates), 'raw report must surface actionableCandidates');
    assert.ok(Array.isArray(rawReport.report.referenceOnly), 'raw report must surface referenceOnly');
    assert.equal(rawReport.report.actionableCandidates.length, 2, 'two paw-feel clusters → two actionable candidates');
    assert.equal(rawReport.report.referenceOnly.length, 0, 'no eval-domain clusters in this fixture');
    assert.ok(rawReport.report.actionableCandidates[0].followupDraft, 'actionable candidate must carry followupDraft');

    // snapshot conforms to a2a bundle schema
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.verdictId, verdictId);
    assert.equal(snapshot.featureId, 'F245');
    assert.ok(snapshot.evalSnapshotId, 'snapshot must have evalSnapshotId');
    assert.ok(snapshot.window.durationHours >= 0, 'snapshot.window must have durationHours');
    assert.ok(Array.isArray(snapshot.components) && snapshot.components.length >= 1);
    assert.ok(snapshot.components[0].id && snapshot.components[0].name);

    // provenance references raw report with sha256
    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.verdictId, verdictId);
    assert.equal(provenance.generator.name, 'eval-friction-live-verdict');
    assert.ok(provenance.rawInputs.length >= 1);
    assert.match(provenance.rawInputs[0].sha256, /^[0-9a-f]{64}$/);

    // canonical refs
    assert.match(result.refs.snapshotRef, /^snapshot:bundle\//);
    assert.ok(result.refs.snapshotRef.endsWith('/snapshot'));
    for (const ref of result.refs.attributionRefs) {
      assert.match(ref, /^attribution:bundle\//);
    }
  });

  it('writes a no-finding bundle when there are zero clusters (keep_observe)', async () => {
    const { generateFrictionLiveVerdict } = await import(IMPORT_LIVE_VERDICT);
    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    const result = generateFrictionLiveVerdict({
      verdictId: 'vhp-friction-empty',
      harnessFeedbackRoot,
      domain: DOMAIN,
      rollupInput: stubRollupInput({ clusters: 0 }),
      selector: SELECTOR,
      submittedPacket: stubPacket({ id: 'vhp-friction-empty' }),
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.equal(attribution.findings.length, 0, 'no clusters → zero findings');
    assert.ok(attribution.noFindingRecord, 'must carry noFindingRecord when no findings');
    const rawReport = JSON.parse(readFileSync(join(result.bundleDir, 'raw', 'rollup-report.json'), 'utf8'));
    assert.deepEqual(rawReport.report.actionableCandidates, [], 'empty rollup → no actionable candidates');
    assert.deepEqual(rawReport.report.referenceOnly, [], 'empty rollup → no reference-only clusters');
  });

  it('emits an aggregate tail finding when all clusters fold into the tail, not no-finding (cloud-R3 P2)', async () => {
    const { generateFrictionLiveVerdict } = await import(IMPORT_LIVE_VERDICT);
    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    const result = generateFrictionLiveVerdict({
      verdictId: 'vhp-friction-tail',
      harnessFeedbackRoot,
      domain: DOMAIN,
      // 12 clusters + tokenCap=1 → fold-down loop drives cut to 0: topClusters empty, tail holds all.
      rollupInput: stubRollupInput({ clusters: 12 }),
      selector: { ...SELECTOR, tokenCap: 1 },
      submittedPacket: stubPacket({ id: 'vhp-friction-tail' }),
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    const attribution = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.equal(attribution.noFindingRecord, undefined, 'non-empty tail must NOT be a no-finding record');
    assert.equal(attribution.findings.length, 1, 'folded tail surfaces one aggregate finding');
    assert.match(attribution.findings[0].id, /tail-aggregate/);
    assert.equal(
      attribution.findings[0].attribution.evidence[0].anchor,
      'friction-rollup/tail_cluster_count',
      'aggregate finding anchors to the tail_cluster_count metric present in the snapshot',
    );
  });

  it('throws when submitted packet featureId does not match domain target F245', async () => {
    const { generateFrictionLiveVerdict } = await import(IMPORT_LIVE_VERDICT);
    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    assert.throws(
      () =>
        generateFrictionLiveVerdict({
          verdictId: 'vhp-friction-mismatch',
          harnessFeedbackRoot,
          domain: DOMAIN,
          rollupInput: stubRollupInput({ clusters: 1 }),
          selector: SELECTOR,
          submittedPacket: stubPacket({
            id: 'vhp-friction-mismatch',
            harnessUnderEval: { featureId: 'F999', componentId: 'friction-rollup', name: 'x' },
          }),
          generatedAt: '2026-06-20T00:00:00.000Z',
        }),
      /submitted_packet_evidence_mismatch|F245/,
    );
  });
});
