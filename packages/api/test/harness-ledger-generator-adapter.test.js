/**
 * F257 Eval Engine Wiring — harness-ledger generator adapter tests.
 *
 * KD-17 snapshot-first: adapter reads stored run snapshot by evalRunId
 * (no direct GuardRejectionEventLog query). Tests pre-write snapshot files.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { createHarnessLedgerGeneratorAdapter } = await import(
  '../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
);

// ── Test helpers ──

/** Stable window constants — both helpers use the same values so KD-17 window mismatch check passes. */
const DEFAULT_WINDOW_START = 1700000000000;
const DEFAULT_WINDOW_END = 1700604800000; // 7 days later (168 hours)

function makeTmpDir() {
  const dir = join(tmpdir(), `hlga-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePacket(overrides = {}) {
  return {
    id: `verdict-${Math.random().toString(36).slice(2, 10)}`,
    domainId: 'eval:harness-ledger',
    ...overrides,
  };
}

/** Counter for generating unique but format-valid evalRunIds. */
let evalRunCounter = 0;
function safeEvalRunId() {
  return `hlr-${1700000000000 + evalRunCounter++}-a1b2c3d4`;
}

function makeSourceRefs(overrides = {}) {
  return {
    kind: 'prompt-segments',
    windowStartMs: DEFAULT_WINDOW_START,
    windowEndMs: DEFAULT_WINDOW_END,
    evalRunId: safeEvalRunId(),
    ...overrides,
  };
}

function makeDeps(harnessFeedbackRoot, ownerUserId = 'user_1') {
  return {
    harnessFeedbackRoot,
    liveHarnessFeedbackRoot: harnessFeedbackRoot,
    ownerUserId,
  };
}

/** Write a stored run snapshot to the expected filesystem path. */
function writeRunSnapshot(rootDir, evalRunId, snapshotData = {}) {
  const dir = join(rootDir, 'run-snapshots');
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    evalRunId,
    producedAt: new Date().toISOString(),
    ownerUserId: 'user_1',
    window: { startMs: DEFAULT_WINDOW_START, endMs: DEFAULT_WINDOW_END, durationHours: 168 },
    totalEvents: 0,
    byKind: {},
    byGuard: {},
    sampleAnchors: [],
    howCounted: 'zset-window-scan',
    ...snapshotData,
  };
  writeFileSync(join(dir, `${evalRunId}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

describe('harness-ledger-generator-adapter', () => {
  test('throws on wrong sourceRefs kind', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();

    await assert.rejects(
      () => generator(makePacket(), { kind: 'qc-metrics-rollup' }, makeDeps(makeTmpDir())),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_wrong_kind'));
        return true;
      },
    );
  });

  test('throws on invalid window (end <= start)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const now = Date.now();

    await assert.rejects(
      () =>
        generator(
          makePacket(),
          makeSourceRefs({ windowStartMs: now, windowEndMs: now - 1000 }),
          makeDeps(makeTmpDir()),
        ),
      (err) => {
        assert.ok(err.message.includes('invalid_window'));
        return true;
      },
    );
  });

  test('throws on non-finite window values', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();

    await assert.rejects(
      () =>
        generator(
          makePacket(),
          makeSourceRefs({ windowStartMs: Number.NaN, windowEndMs: Date.now() }),
          makeDeps(makeTmpDir()),
        ),
      (err) => {
        assert.ok(err.message.includes('invalid_window'));
        return true;
      },
    );
  });

  test('throws when evalRunId is missing (KD-17)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();

    await assert.rejects(
      () =>
        generator(
          makePacket(),
          { kind: 'prompt-segments', windowStartMs: Date.now() - 1000, windowEndMs: Date.now() },
          makeDeps(makeTmpDir()),
        ),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_missing_run_id'));
        return true;
      },
    );
  });

  test('throws when snapshot file is missing (fail-closed KD-17)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();

    await assert.rejects(
      () => generator(makePacket(), makeSourceRefs({ evalRunId: 'hlr-9999999999999-deadbeef' }), makeDeps(tmpDir)),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_snapshot_missing'));
        return true;
      },
    );

    rmSync(tmpDir, { recursive: true });
  });

  test('produces zero-event verdict with noFindingRecord', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'zero-events' });

    writeRunSnapshot(tmpDir, evalRunId, { totalEvents: 0, byKind: {}, byGuard: {} });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    assert.ok(result.verdictPath.endsWith('zero-events.md'));
    assert.ok(result.bundleDir.endsWith('zero-events'));

    // Verify files exist
    assert.ok(existsSync(result.verdictPath), 'verdict markdown exists');
    assert.ok(existsSync(join(result.bundleDir, 'snapshot.json')), 'snapshot.json exists');
    assert.ok(existsSync(join(result.bundleDir, 'attribution.json')), 'attribution.json exists');
    assert.ok(existsSync(join(result.bundleDir, 'provenance.json')), 'provenance.json exists');

    // Check snapshot
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.totalEvents, 0);
    assert.equal(snapshot.featureId, 'F257');
    assert.equal(snapshot.components[0].confidence, 'no-data');

    // Check attribution has noFindingRecord
    const attr = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.ok(attr.noFindingRecord, 'should have noFindingRecord for zero events');
    assert.equal(attr.findings.length, 0);

    // Check provenance has producedBy.runId (KD-17)
    const prov = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(prov.producedBy.runId, evalRunId);

    // Check verdict markdown
    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('feedback_type: live-verdict'));
    assert.ok(md.includes('domain_id: eval:harness-ledger'));
    assert.ok(md.includes('keep_observe'));
    assert.ok(md.includes('**Events**: 0'));

    rmSync(tmpDir, { recursive: true });
  });

  test('produces verdict with events from mixed kinds', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'mixed-events' });

    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 3,
      byKind: { http_rate_limit: 2, route_decision_block: 1 },
      byGuard: {
        hold_ball_rate_limit: { count: 2, kinds: ['http_rate_limit'] },
        a2a_block_pingpong: { count: 1, kinds: ['route_decision_block'] },
      },
    });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    // Check snapshot
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.totalEvents, 3);
    assert.equal(snapshot.byKind.http_rate_limit, 2);
    assert.equal(snapshot.byKind.route_decision_block, 1);
    assert.equal(snapshot.byGuard.hold_ball_rate_limit, 2);
    assert.equal(snapshot.byGuard.a2a_block_pingpong, 1);
    assert.equal(snapshot.components[0].confidence, 'medium');

    // Check attribution has schema-compliant findings
    const attr = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.ok(!attr.noFindingRecord, 'should NOT have noFindingRecord when events exist');
    assert.equal(attr.findings.length, 2); // 2 distinct guards

    const holdBallFinding = attr.findings.find((f) => f.id === 'f257-guard-hold_ball_rate_limit');
    assert.ok(holdBallFinding, 'finding for hold_ball_rate_limit exists');
    assert.equal(holdBallFinding.frictionSignal.severity, 'low'); // 2 events < 5
    assert.equal(holdBallFinding.frictionSignal.confidence, 0.7);
    assert.equal(holdBallFinding.frictionSignal.type, 'http_rate_limit');
    assert.equal(holdBallFinding.attribution.primaryLayer, 'guard-rejection-log');
    assert.ok(holdBallFinding.attribution.evidence.length >= 1);
    assert.equal(holdBallFinding.attribution.evidence[0].anchor, 'guard-rejection-log/http_rate_limit');
    assert.equal(holdBallFinding.proposedAction[0].target, 'hold_ball_rate_limit');

    const pingpongFinding = attr.findings.find((f) => f.id === 'f257-guard-a2a_block_pingpong');
    assert.ok(pingpongFinding, 'finding for a2a_block_pingpong exists');
    assert.equal(pingpongFinding.frictionSignal.type, 'route_decision_block');
    assert.equal(pingpongFinding.attribution.evidence[0].anchor, 'guard-rejection-log/route_decision_block');

    // Check verdict markdown
    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('**Events**: 3'));
    assert.ok(md.includes('http_rate_limit'));
    assert.ok(md.includes('route_decision_block'));

    rmSync(tmpDir, { recursive: true });
  });

  test('rejects window mismatch between selector and stored snapshot (KD-17)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'window-mismatch' });

    // Snapshot stored with default window [DEFAULT_WINDOW_START, DEFAULT_WINDOW_END)
    writeRunSnapshot(tmpDir, evalRunId, { totalEvents: 0, byKind: {}, byGuard: {} });

    // Selector claims a DIFFERENT window — KD-17 invariant: decision and artifact must share the same data source
    const driftedStart = DEFAULT_WINDOW_START + 1000;
    const driftedEnd = DEFAULT_WINDOW_END + 1000;

    await assert.rejects(
      () =>
        generator(
          packet,
          makeSourceRefs({ windowStartMs: driftedStart, windowEndMs: driftedEnd, evalRunId }),
          makeDeps(tmpDir),
        ),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_window_mismatch'));
        assert.ok(err.message.includes('KD-17'));
        return true;
      },
    );

    rmSync(tmpDir, { recursive: true });
  });

  test('rejects evalRunId with invalid format (path traversal defense)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'traversal' });

    // These are all format-invalid: defense-in-depth rejects them before filesystem access
    const maliciousIds = [
      '../../../etc/passwd',
      'hlr-123-GGGGGGGG', // uppercase hex
      'hlr-notanumber-abcdef01', // non-numeric timestamp
      'run-1700000000000-abcdef01', // wrong prefix
      'hlr-1700000000000-abc', // too-short hex
    ];

    for (const badId of maliciousIds) {
      await assert.rejects(
        () =>
          generator(
            packet,
            {
              kind: 'prompt-segments',
              windowStartMs: DEFAULT_WINDOW_START,
              windowEndMs: DEFAULT_WINDOW_END,
              evalRunId: badId,
            },
            makeDeps(tmpDir),
          ),
        (err) => {
          assert.ok(
            err.message.includes('harness_ledger_adapter_invalid_run_id'),
            `expected invalid_run_id error for '${badId}', got: ${err.message}`,
          );
          return true;
        },
      );
    }

    rmSync(tmpDir, { recursive: true });
  });

  test('provenance contains sha256 of snapshot + producedBy.runId', async () => {
    const { createHash } = await import('node:crypto');
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'prov-check' });

    writeRunSnapshot(tmpDir, evalRunId);

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const snapshotJson = readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8');
    const expectedSha = createHash('sha256').update(snapshotJson).digest('hex');

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.rawInputs[0].sha256, expectedSha);
    assert.equal(provenance.generator.name, 'harness-ledger-generator-adapter');
    assert.equal(provenance.producedBy.runId, evalRunId);

    rmSync(tmpDir, { recursive: true });
  });

  test('verdict markdown uses packet fields when present', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();

    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 1,
      byKind: { http_rate_limit: 1 },
      byGuard: { hold_ball_rate_limit: { count: 1, kinds: ['http_rate_limit'] } },
    });

    const packet = makePacket({
      id: 'custom-verdict',
      verdict: 'regress',
      phenomenon: 'Guard rejections spiked after latest deploy',
      harnessUnderEval: { featureId: 'F257', componentId: 'guard-rejection-log', name: 'Harness Ledger v2' },
      ownerAsk: { requestedAction: 'Investigate spike in hold_ball rejections' },
      acceptanceReevalPlan: { nextEvalAt: '2026-07-17T00:00:00Z' },
    });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('`regress`'), 'uses packet verdict');
    assert.ok(md.includes('Guard rejections spiked'), 'uses packet phenomenon');
    assert.ok(md.includes('Harness Ledger v2'), 'uses packet harnessUnderEval');
    assert.ok(md.includes('Investigate spike'), 'uses packet ownerAsk');
    assert.ok(md.includes('2026-07-17'), 'uses packet reevalPlan');

    rmSync(tmpDir, { recursive: true });
  });

  test('verdict YAML frontmatter includes all required Eval Hub fields', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'frontmatter-check' });

    writeRunSnapshot(tmpDir, evalRunId);

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));
    const md = readFileSync(result.verdictPath, 'utf8');

    assert.ok(md.includes('feature_ids: [F257]'));
    assert.ok(md.includes('doc_kind: harness-feedback'));
    assert.ok(md.includes('feedback_type: live-verdict'));
    assert.ok(md.includes('domain_id: eval:harness-ledger'));
    assert.ok(md.includes('packet_id: frontmatter-check'));
    assert.ok(md.includes('source_snapshot:'));

    rmSync(tmpDir, { recursive: true });
  });

  test('bundle snapshot window matches selector', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'window-check' });

    // Uses default window from helpers — both makeSourceRefs and writeRunSnapshot share DEFAULT_WINDOW_START/END
    writeRunSnapshot(tmpDir, evalRunId);

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.window.startMs, DEFAULT_WINDOW_START);
    assert.equal(snapshot.window.endMs, DEFAULT_WINDOW_END);
    assert.equal(snapshot.window.durationHours, 168); // 7 days × 24h

    rmSync(tmpDir, { recursive: true });
  });

  // ── Resolver round-trip: bundles pass resolveA2aEvidenceBundle validation ──

  test('zero-events bundle passes resolveA2aEvidenceBundle round-trip', async () => {
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'roundtrip-zero' });

    writeRunSnapshot(tmpDir, evalRunId, { totalEvents: 0, byKind: {}, byGuard: {} });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const resolved = resolveA2aEvidenceBundle({ verdictId: packet.id, bundleDir: result.bundleDir });

    assert.equal(resolved.verdictId, packet.id);
    assert.ok(resolved.snapshot.featureId === 'F257');
    assert.equal(resolved.attributionReport.findings.length, 0);
    assert.ok(resolved.attributionReport.noFindingRecord);
    assert.equal(resolved.provenance.generator.name, 'harness-ledger-generator-adapter');

    rmSync(tmpDir, { recursive: true });
  });

  test('mixed-events bundle passes resolveA2aEvidenceBundle round-trip', async () => {
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = safeEvalRunId();
    const packet = makePacket({ id: 'roundtrip-mixed' });

    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 3,
      byKind: { http_rate_limit: 2, route_decision_block: 1 },
      byGuard: {
        hold_ball_rate_limit: { count: 2, kinds: ['http_rate_limit'] },
        a2a_block_pingpong: { count: 1, kinds: ['route_decision_block'] },
      },
    });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const resolved = resolveA2aEvidenceBundle({ verdictId: packet.id, bundleDir: result.bundleDir });

    assert.equal(resolved.verdictId, packet.id);
    assert.ok(resolved.snapshot.featureId === 'F257');
    assert.ok(resolved.snapshot.window.durationHours >= 0);
    assert.ok(resolved.snapshot.components.length >= 1);
    assert.equal(resolved.attributionReport.findings.length, 2);
    assert.ok(!resolved.attributionReport.noFindingRecord);

    const finding = resolved.attributionReport.findings[0];
    assert.ok(finding.id.startsWith('f257-guard-'));
    assert.ok(['low', 'medium', 'high'].includes(finding.frictionSignal.severity));
    assert.equal(finding.attribution.primaryLayer, 'guard-rejection-log');
    assert.ok(finding.attribution.evidence.length >= 1);
    assert.ok(finding.proposedAction.length >= 1);

    rmSync(tmpDir, { recursive: true });
  });
});
