/**
 * F253 Phase C — AC-C3: QC generator adapter tests.
 *
 * Validates that the QC metrics provider returns the right shape
 * and the generator adapter follows the VerdictGenerator contract.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('QcMetricsProvider', () => {
  test('snapshot has all 4 metric fields', async () => {
    const { resolveQcMetrics } = await import('../dist/infrastructure/harness-eval/qc-metrics-provider.js');
    const snapshot = resolveQcMetrics({
      kind: 'qc-metrics-rollup',
      windowStartMs: Date.now() - 7 * 24 * 3600 * 1000,
      windowEndMs: Date.now(),
    });
    assert.ok(typeof snapshot.findingYield === 'number', 'findingYield');
    assert.ok(typeof snapshot.falsePositiveRate === 'number', 'falsePositiveRate');
    assert.ok(typeof snapshot.reviewerDelta === 'number', 'reviewerDelta');
    assert.ok(typeof snapshot.postMergeBugRate === 'number', 'postMergeBugRate');
    assert.ok(typeof snapshot.prCount === 'number', 'prCount');
    assert.ok(typeof snapshot.windowDays === 'number', 'windowDays');
  });

  test('windowDays reflects selector range', async () => {
    const { resolveQcMetrics } = await import('../dist/infrastructure/harness-eval/qc-metrics-provider.js');
    const now = Date.now();
    const snapshot = resolveQcMetrics({
      kind: 'qc-metrics-rollup',
      windowStartMs: now - 14 * 24 * 3600 * 1000,
      windowEndMs: now,
    });
    // ~14 days (allow rounding)
    assert.ok(snapshot.windowDays >= 13 && snapshot.windowDays <= 15, `windowDays=${snapshot.windowDays}`);
  });
});

describe('QC eval domain integration contract', () => {
  test('qc-metrics-rollup is a known sourceRefs kind (P1-2 fix)', async () => {
    const { isKnownSourceRefsKind } = await import('../dist/infrastructure/harness-eval/publish-verdict/validation.js');
    assert.ok(
      isKnownSourceRefsKind('qc-metrics-rollup'),
      'qc-metrics-rollup must be registered in KNOWN_SOURCE_REFS_KINDS',
    );
  });

  test('eval:qc has publish verdict instructions (P1-1 fix)', async () => {
    // Read the compiled source to verify PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN
    // includes eval:qc. We can't easily load buildEvalCatInvocation in isolation
    // (needs domain loader + filesystem), so we verify the constant is wired
    // by checking the compiled JS source contains the mapping.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const filePath = path.resolve(import.meta.dirname, '../dist/infrastructure/harness-eval/eval-cat-invocation.js');
    const source = fs.readFileSync(filePath, 'utf-8');
    // The map must contain 'eval:qc' as a key with publish instructions
    assert.ok(
      source.includes("'eval:qc': PUBLISH_VERDICT_INSTRUCTIONS_QC") || source.includes('"eval:qc"'),
      'eval:qc must be mapped in PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN',
    );
    // The instructions must reference qc-metrics-rollup kind
    assert.ok(
      source.includes('qc-metrics-rollup'),
      'eval:qc publish instructions must reference qc-metrics-rollup selector kind',
    );
  });

  test('adapter writes verdict to verdicts/<id>.md (P1-3 fix)', async () => {
    const { createQcGeneratorAdapter } = await import(
      '../dist/infrastructure/harness-eval/publish-verdict/qc-generator-adapter.js'
    );
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
    const adapter = createQcGeneratorAdapter();
    const now = Date.now();
    const result = await adapter(
      { id: 'test-path-contract', domainId: 'eval:qc' },
      { kind: 'qc-metrics-rollup', windowStartMs: now - 7 * 86400000, windowEndMs: now },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir },
    );

    // Verdict must be flat file: verdicts/<id>.md (not verdicts/<id>/verdict.md)
    assert.equal(result.verdictPath, path.join(tmpDir, 'verdicts', 'test-path-contract.md'));
    // Bundle must be top-level: bundles/<id> (not verdicts/<id>/bundle)
    assert.equal(result.bundleDir, path.join(tmpDir, 'bundles', 'test-path-contract'));
    // Files must actually exist
    assert.ok(fs.existsSync(result.verdictPath), 'verdict file must exist');
    assert.ok(fs.existsSync(result.bundleDir), 'bundle dir must exist');
    assert.ok(fs.existsSync(path.join(result.bundleDir, 'snapshot.json')), 'snapshot.json must exist');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('QC verdict Eval Hub compatibility (cloud P1 fix)', () => {
  /** Helper: run adapter in a temp dir and return paths + content */
  async function runAdapter() {
    const { createQcGeneratorAdapter } = await import(
      '../dist/infrastructure/harness-eval/publish-verdict/qc-generator-adapter.js'
    );
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-hub-compat-'));
    const adapter = createQcGeneratorAdapter();
    const now = Date.now();
    const result = await adapter(
      { id: 'hub-compat-test', domainId: 'eval:qc' },
      { kind: 'qc-metrics-rollup', windowStartMs: now - 7 * 86400000, windowEndMs: now },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir },
    );
    const verdictMd = fs.readFileSync(result.verdictPath, 'utf8');
    return { tmpDir, result, verdictMd, fs, path };
  }

  test('verdict markdown has YAML frontmatter with feedback_type: live-verdict', async () => {
    const { tmpDir, verdictMd, fs } = await runAdapter();
    // frontmatter must exist between --- delimiters
    const fmMatch = verdictMd.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'verdict must have YAML frontmatter delimited by ---');
    assert.ok(
      fmMatch[1].includes('feedback_type: live-verdict'),
      'frontmatter must contain feedback_type: live-verdict',
    );
    assert.ok(fmMatch[1].includes('domain_id: eval:qc'), 'frontmatter must contain domain_id');
    assert.ok(fmMatch[1].includes('packet_id:'), 'frontmatter must contain packet_id');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('verdict markdown has required structured bullets for buildEvalHubItem', async () => {
    const { tmpDir, verdictMd, fs } = await runAdapter();
    // buildEvalHubItem extracts these bullets via extractBullet(markdown, label)
    assert.ok(verdictMd.match(/^- Verdict:\s+/m), 'must have "- Verdict:" bullet');
    assert.ok(verdictMd.match(/^- Phenomenon:\s+/m), 'must have "- Phenomenon:" bullet');
    assert.ok(verdictMd.match(/^- Harness:\s+/m), 'must have "- Harness:" bullet');
    assert.ok(verdictMd.match(/^- Owner ask:\s+/m), 'must have "- Owner ask:" bullet');
    assert.ok(verdictMd.match(/^- Re-eval:\s+/m), 'must have "- Re-eval:" bullet');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bundle contains attribution.json and provenance.json', async () => {
    const { tmpDir, result, fs, path } = await runAdapter();
    assert.ok(fs.existsSync(path.join(result.bundleDir, 'attribution.json')), 'bundle must contain attribution.json');
    assert.ok(fs.existsSync(path.join(result.bundleDir, 'provenance.json')), 'bundle must contain provenance.json');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bundle passes resolveA2aEvidenceBundle validation', async () => {
    const { tmpDir, result, fs } = await runAdapter();
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    // Must not throw — if it does, the verdict is invisible to Eval Hub
    const resolved = resolveA2aEvidenceBundle({
      bundleDir: result.bundleDir,
      verdictId: 'hub-compat-test',
    });
    assert.equal(resolved.verdictId, 'hub-compat-test');
    assert.ok(resolved.snapshot.components.length >= 1, 'snapshot must have at least 1 component');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses packet verdict/phenomenon/ownerAsk/nextEvalAt when provided (cloud P2 fix)', async () => {
    const { createQcGeneratorAdapter } = await import(
      '../dist/infrastructure/harness-eval/publish-verdict/qc-generator-adapter.js'
    );
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-packet-fields-'));
    const adapter = createQcGeneratorAdapter();
    const now = Date.now();
    const result = await adapter(
      {
        id: 'packet-fields-test',
        domainId: 'eval:qc',
        verdict: 'fix',
        phenomenon: 'False positive rate exceeded 40% threshold',
        harnessUnderEval: { featureId: 'F253', componentId: 'qc-review', name: 'Review Pipeline' },
        ownerAsk: {
          targetFeatureId: 'F253',
          targetOwnerCatId: 'opus',
          requestedAction: 'Tune cloud review prompt to reduce FP rate',
        },
        acceptanceReevalPlan: { nextEvalAt: '2026-07-05T00:00:00.000Z', closureCondition: 'FP < 20%' },
      },
      { kind: 'qc-metrics-rollup', windowStartMs: now - 7 * 86400000, windowEndMs: now },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir },
    );

    const verdictMd = fs.readFileSync(result.verdictPath, 'utf8');
    // Packet fields must appear in verdict markdown, not hard-coded defaults
    assert.ok(verdictMd.includes('`fix`'), 'verdict must use packet.verdict (fix), not hard-coded keep_observe');
    assert.ok(verdictMd.includes('False positive rate exceeded'), 'phenomenon must come from packet');
    assert.ok(verdictMd.includes('F253/qc-review (Review Pipeline)'), 'harness must come from packet.harnessUnderEval');
    assert.ok(verdictMd.includes('Tune cloud review prompt'), 'owner ask must come from packet.ownerAsk');
    assert.ok(verdictMd.includes('2026-07-05T00:00:00.000Z'), 'nextEvalAt must appear in Re-eval bullet');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('createQcGeneratorAdapter', () => {
  test('rejects wrong sourceRefs kind', async () => {
    const { createQcGeneratorAdapter } = await import(
      '../dist/infrastructure/harness-eval/publish-verdict/qc-generator-adapter.js'
    );
    const adapter = createQcGeneratorAdapter();
    const fakePacket = { id: 'test', domainId: 'eval:qc' };
    const wrongRefs = { kind: 'a2a-snapshot-attribution' };
    const fakeDeps = { harnessFeedbackRoot: '/tmp', liveHarnessFeedbackRoot: '/tmp' };

    await assert.rejects(
      () => adapter(fakePacket, wrongRefs, fakeDeps),
      (err) => err.message.includes('qc_adapter_wrong_kind'),
    );
  });

  test('rejects invalid window (end before start)', async () => {
    const { createQcGeneratorAdapter } = await import(
      '../dist/infrastructure/harness-eval/publish-verdict/qc-generator-adapter.js'
    );
    const adapter = createQcGeneratorAdapter();
    const fakePacket = { id: 'test', domainId: 'eval:qc' };
    const badRefs = {
      kind: 'qc-metrics-rollup',
      windowStartMs: Date.now(),
      windowEndMs: Date.now() - 1000,
    };
    const fakeDeps = { harnessFeedbackRoot: '/tmp', liveHarnessFeedbackRoot: '/tmp' };

    await assert.rejects(
      () => adapter(fakePacket, badRefs, fakeDeps),
      (err) => err.message.includes('invalid_window'),
    );
  });
});
