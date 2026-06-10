import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F192 sop-wiring: tests for sop generator adapter + live verdict file-writer.
 *
 * Pattern mirrors publish-verdict-pipeline.test.js structure.
 * TDD — write tests first, see RED, then implement.
 */

// Imports point to dist/ (tsc output), must build first
const IMPORT_PATH_ADAPTER = '../../dist/infrastructure/harness-eval/publish-verdict/sop-generator-adapter.js';
const IMPORT_PATH_LIVE_VERDICT = '../../dist/infrastructure/harness-eval/sop/eval-sop-live-verdict.js';
const IMPORT_PATH_VALIDATION = '../../dist/infrastructure/harness-eval/publish-verdict/validation.js';

/** Minimal valid SopTrace for testing. */
function stubTrace(overrides = {}) {
  return {
    sessionId: 'sess-test-001',
    sopDefinitionId: 'development',
    observedStage: 'worktree',
    commands: [
      { command: 'git worktree add ../wt -b feat/x', exitCode: 0 },
      { command: 'pnpm install', exitCode: 0 },
    ],
    envSnapshot: { REDIS_URL: 'redis://localhost:6398' },
    gitState: {
      branch: 'feat/x',
      ahead: 0,
      behind: 0,
      clean: true,
    },
    handles: { author: 'opus', reviewer: 'codex' },
    shaContext: {},
    ...overrides,
  };
}

/** Minimal valid VerdictHandoffPacket for testing. */
function stubPacket(overrides = {}) {
  return {
    id: 'vhp-eval-sop-development-test-001',
    domainId: 'eval:sop',
    createdAt: '2026-06-10T00:00:00.000Z',
    phenomenon: 'SOP development: 0 violations',
    harnessUnderEval: {
      featureId: 'F192',
      componentId: 'development',
      name: 'SOP development compliance',
    },
    evidencePacket: {
      snapshotRefs: ['snapshot:sop-eval/development/sess-test-001'],
      attributionRefs: ['attribution:sop-eval/no-violation'],
      metricRefs: ['sop_violations_blocker', 'sop_rules_passed'],
      sampleTraceRefs: ['session:sess-test-001'],
    },
    dailyTrend: {
      window: '336h',
      current: {},
      baseline: {},
      threshold: {},
      direction: 'flat',
    },
    rootCauseHypothesis: {
      summary: 'All machine-checkable SOP predicates passed.',
      confidence: 'medium',
      alternatives: ['Clean result may hide infrequent violations.'],
    },
    verdict: 'keep_observe',
    ownerAsk: {
      targetFeatureId: 'F192',
      targetOwnerCatId: 'opus',
      requestedAction: 'No action required.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-06-24T00:00:00.000Z',
      closureCondition: 'next eval remains clean',
    },
    counterarguments: ['A clean eval window may hide infrequent violations.'],
    ...overrides,
  };
}

/** Minimal valid SopTraceSourceSelector. */
function stubSopSourceRefs(overrides = {}) {
  return {
    kind: 'sop-trace-eval',
    sopDefinitionId: 'development',
    trace: stubTrace(),
    ...overrides,
  };
}

// ---- Validation Tests ----

describe('sop sourceRefs validation', () => {
  it('isSopSourceRefs returns true for sop-trace-eval kind', async () => {
    const { isSopSourceRefs } = await import(IMPORT_PATH_VALIDATION);
    const refs = stubSopSourceRefs();
    assert.equal(isSopSourceRefs(refs), true);
  });

  it('isSopSourceRefs returns false for other kinds', async () => {
    const { isSopSourceRefs } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(isSopSourceRefs({ kind: 'a2a-snapshot-attribution' }), false);
    assert.equal(isSopSourceRefs({ kind: 'capability-wakeup-trial-window' }), false);
    assert.equal(isSopSourceRefs(undefined), false);
  });

  it('inferSourceRefsKind returns sop-trace-eval for sop refs', async () => {
    const { inferSourceRefsKind } = await import(IMPORT_PATH_VALIDATION);
    const refs = stubSopSourceRefs();
    assert.equal(inferSourceRefsKind(refs), 'sop-trace-eval');
  });

  it('validateSopTraceSelector rejects missing sopDefinitionId', async () => {
    const { validateSopTraceSelector } = await import(IMPORT_PATH_VALIDATION);
    const bad = { kind: 'sop-trace-eval', trace: stubTrace() };
    const err = validateSopTraceSelector(bad);
    assert.ok(err, 'should return error string');
    assert.ok(err.includes('sopDefinitionId'), err);
  });

  it('validateSopTraceSelector rejects missing trace', async () => {
    const { validateSopTraceSelector } = await import(IMPORT_PATH_VALIDATION);
    const bad = { kind: 'sop-trace-eval', sopDefinitionId: 'development' };
    const err = validateSopTraceSelector(bad);
    assert.ok(err, 'should return error string');
    assert.ok(err.includes('trace'), err);
  });

  it('validateSopTraceSelector accepts valid selector', async () => {
    const { validateSopTraceSelector } = await import(IMPORT_PATH_VALIDATION);
    const good = stubSopSourceRefs();
    const err = validateSopTraceSelector(good);
    assert.equal(err, null);
  });
});

// ---- Live Verdict File-Writer Tests ----

describe('generateSopLiveVerdict', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sop-verdict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes verdict.md + bundle dir with snapshot/attribution/provenance', async () => {
    const { generateSopLiveVerdict } = await import(IMPORT_PATH_LIVE_VERDICT);

    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    const verdictId = 'vhp-eval-sop-development-test-001';
    const result = generateSopLiveVerdict({
      verdictId,
      harnessFeedbackRoot,
      trace: stubTrace(),
      evalResults: [
        { ruleId: 'R-WT-1', status: 'pass' },
        { ruleId: 'R-WT-2', status: 'skipped', reason: 'manual_only' },
      ],
      submittedPacket: stubPacket(),
    });

    // verdict.md exists with YAML frontmatter (P1-2 fix)
    assert.ok(existsSync(result.path), 'verdict.md should exist');
    const verdictContent = readFileSync(result.path, 'utf8');
    assert.ok(verdictContent.includes('feedback_type: live-verdict'), 'verdict.md must have live-verdict frontmatter');
    assert.ok(verdictContent.includes('domain_id: eval:sop'), 'verdict.md must have domain_id');
    assert.ok(verdictContent.includes('packet_id:'), 'verdict.md must have packet_id');
    assert.ok(verdictContent.startsWith('---\n'), 'verdict.md must start with YAML frontmatter');

    // bundle dir exists with snapshot + attribution + provenance
    assert.ok(existsSync(result.bundleDir), 'bundle dir should exist');
    assert.ok(existsSync(join(result.bundleDir, 'snapshot.json')));
    assert.ok(existsSync(join(result.bundleDir, 'attribution.json')));
    assert.ok(existsSync(join(result.bundleDir, 'provenance.json')));

    // snapshot conforms to a2a bundle schema (P1-1 fix)
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.ok(snapshot.evalSnapshotId, 'snapshot must have evalSnapshotId');
    assert.ok(snapshot.window, 'snapshot must have window');
    assert.ok(snapshot.window.durationHours > 0, 'snapshot.window must have durationHours');
    assert.ok(Array.isArray(snapshot.components), 'snapshot must have components array');
    assert.ok(snapshot.components.length >= 1, 'snapshot must have at least 1 component');
    assert.ok(snapshot.components[0].id, 'component must have id');
    assert.ok(snapshot.components[0].name, 'component must have name');

    // attribution conforms to a2a bundle schema (P1-1 fix)
    const attribution = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.ok(attribution.evalSnapshotId, 'attribution must have evalSnapshotId');
    assert.ok(Array.isArray(attribution.findings), 'attribution must have findings array');

    // raw input dir exists with trace + eval results
    assert.ok(existsSync(result.rawInputDir), 'raw input dir should exist');
    assert.ok(existsSync(join(result.rawInputDir, 'trace.json')));
    assert.ok(existsSync(join(result.rawInputDir, 'eval-results.json')));

    // provenance references raw inputs
    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.ok(provenance.rawInputs.length >= 2, 'should have at least 2 raw inputs');
    assert.ok(provenance.rawInputs.some((r) => r.path.includes('trace.json')));

    // R2 P1-2 fix: evidence refs use canonical format from resolveA2aEvidenceBundle
    assert.match(
      result.refs.snapshotRef,
      /^snapshot:bundle\//,
      'snapshotRef must use canonical snapshot:bundle/ prefix',
    );
    assert.ok(result.refs.snapshotRef.endsWith('/snapshot'), 'snapshotRef must end with /snapshot');
    for (const ref of result.refs.attributionRefs) {
      assert.match(ref, /^attribution:bundle\//, 'attributionRef must use canonical attribution:bundle/ prefix');
    }
  });
});

// ---- Generator Adapter Tests ----

describe('createSopGeneratorAdapter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sop-gen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects non-sop sourceRefs with descriptive error', async () => {
    const { createSopGeneratorAdapter } = await import(IMPORT_PATH_ADAPTER);
    const adapter = createSopGeneratorAdapter();
    const packet = stubPacket();
    const wrongRefs = { kind: 'a2a-snapshot-attribution', snapshotName: 'x', attributionName: 'y' };
    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    await assert.rejects(
      () => adapter(packet, wrongRefs, { harnessFeedbackRoot, liveHarnessFeedbackRoot: harnessFeedbackRoot }),
      (err) => {
        assert.ok(err.message.includes('sop_adapter_wrong_kind'));
        return true;
      },
    );
  });

  it('produces verdictPath + bundleDir for valid sop sourceRefs', async () => {
    const { createSopGeneratorAdapter } = await import(IMPORT_PATH_ADAPTER);
    const adapter = createSopGeneratorAdapter();
    const packet = stubPacket();
    const refs = stubSopSourceRefs();
    const harnessFeedbackRoot = join(tmpDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });

    const result = await adapter(packet, refs, {
      harnessFeedbackRoot,
      liveHarnessFeedbackRoot: harnessFeedbackRoot,
    });

    assert.ok(result.verdictPath, 'should return verdictPath');
    assert.ok(result.bundleDir, 'should return bundleDir');
    assert.ok(existsSync(result.verdictPath), 'verdict file should exist on disk');
    assert.ok(existsSync(result.bundleDir), 'bundle dir should exist on disk');
  });
});
