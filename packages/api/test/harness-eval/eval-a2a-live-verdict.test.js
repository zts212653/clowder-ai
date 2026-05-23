import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateA2aLiveVerdict } from '../../dist/infrastructure/harness-eval/eval-a2a-live-verdict.js';

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

function createRawArtifacts() {
  const root = mkdtempSync(join(tmpdir(), 'f192-live-verdict-'));
  const rawDir = join(root, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const snapshotPath = join(rawDir, '2026-05-22-F167-eval.yaml');
  const attributionPath = join(rawDir, '2026-05-22-F167-attribution.yaml');
  writeFileSync(
    snapshotPath,
    `---
doc_kind: harness-feedback
feedback_type: eval-snapshot
feature_id: F167
generated_at: "2026-05-22T18:00:00.000Z"
---

# F167 Runtime Eval Snapshot — 2026-05-22

window:
  start_ms: 1779430000000
  end_ms: 1779516400000
  duration_hours: 24

components:
  - id: C1
    name: "routing contract"
    confidence: medium
    activation_counts:
      c1.route_seen: 12
    friction_counts:
      {}
  - id: C2
    name: "forced-pass guard"
    confidence: medium
    activation_counts:
      c2.verdict_hint_emitted: 20
    friction_counts:
      c2.verdict_without_pass_count: 9
`,
  );
  writeFileSync(
    attributionPath,
    `---
doc_kind: harness-feedback
feedback_type: attribution
feature_id: F167
eval_snapshot_id: "eval-F167-2026-05-22"
generated_at: "2026-05-22T18:01:00.000Z"
---

# F167 Attribution Report — 2026-05-22

finding_count: 1

findings:
  - id: AR-2026-05-22-001
    related_feature: F167
    friction_signal:
      type: c2.verdict_without_pass_count
      severity: medium
      confidence: 0.7
    attribution:
      primary_layer: harness_misfit
      pipeline_or_human: pipeline
      evidence:
        - type: counter
          anchor: "C2/c2.verdict_without_pass_count"
          excerpt: "c2.verdict_without_pass_count=9 exceeds threshold"
    proposed_action:
      - action: harness-tune
        target: "C2"
        rationale: "forced-pass hint rate is high"
    fingerprint: "c2.verdict_without_pass_count::C2/c2.verdict_without_pass_count"
    status: open
`,
  );
  return { root, snapshotPath, attributionPath };
}

describe('eval:a2a live verdict generator', () => {
  it('writes a live verdict and same-id sanitized evidence bundle without auto-handoff', () => {
    const { root, snapshotPath, attributionPath } = createRawArtifacts();
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const verdictId = '2026-05-22-eval-a2a-live-verdict';

    const result = generateA2aLiveVerdict({
      verdictId,
      rawSnapshotPath: snapshotPath,
      rawAttributionPath: attributionPath,
      harnessFeedbackRoot,
      domain,
      generatedAt: '2026-05-22T18:02:00.000Z',
      generatorCommit: 'test-commit',
    });

    assert.equal(result.isLive, true);
    assert.equal(result.packet.verdict, 'fix');
    assert.equal(result.packet.evidencePacket.snapshotRefs[0], `snapshot:bundle/${verdictId}/snapshot`);
    assert.deepEqual(result.packet.evidencePacket.attributionRefs, [
      `attribution:bundle/${verdictId}/AR-2026-05-22-001`,
    ]);
    assert.equal(result.sentCrossThreadMessage, false);
    assert.equal(existsSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'snapshot.json')), true);
    assert.equal(existsSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'attribution.json')), true);
    assert.equal(existsSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'provenance.json')), true);

    const snapshot = JSON.parse(readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'snapshot.json'), 'utf8'));
    assert.deepEqual(
      snapshot.components.map((component) => component.id),
      ['C2'],
      'bundle should keep only the component cited by the verdict finding',
    );

    const provenance = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'provenance.json'), 'utf8'),
    );
    assert.equal(provenance.rawInputs.length, 2);
    assert.match(provenance.rawInputs[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(provenance.sanitizeRulesVersion, 'f192-e-pilot-v1');

    const markdown = readFileSync(result.path, 'utf8');
    assert.match(markdown, /feedback_type: live-verdict/);
    assert.match(markdown, /Live Verdict/);
    assert.doesNotMatch(markdown, /Contract Demo Fixture/);
    assert.doesNotMatch(markdown, /docs\/harness-feedback\/snapshots/);
    assert.match(markdown, new RegExp(`snapshot:bundle/${verdictId}/snapshot`));
  });

  it('normalizes provenance raw input paths to repo-relative portable paths', () => {
    const { root, snapshotPath, attributionPath } = createRawArtifacts();
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const verdictId = '2026-05-22-eval-a2a-live-verdict';

    generateA2aLiveVerdict({
      verdictId,
      rawSnapshotPath: snapshotPath,
      rawAttributionPath: attributionPath,
      harnessFeedbackRoot,
      domain,
      generatedAt: '2026-05-22T18:02:00.000Z',
      generatorCommit: 'test-commit',
    });

    const provenance = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'provenance.json'), 'utf8'),
    );
    assert.deepEqual(
      provenance.rawInputs.map((input) => input.path),
      ['raw/2026-05-22-F167-eval.yaml', 'raw/2026-05-22-F167-attribution.yaml'],
    );
    for (const input of provenance.rawInputs) {
      assert.equal(input.path.startsWith(root), false);
      assert.equal(input.path.startsWith('/'), false);
      assert.doesNotMatch(input.path, /\\/);
    }
  });

  it('accepts contract-valid attribution findings without optional related feature fields', () => {
    const { root, snapshotPath, attributionPath } = createRawArtifacts();
    const rawAttribution = readFileSync(attributionPath, 'utf8')
      .replace('\n    related_feature: F167', '')
      .replace('\n      pipeline_or_human: pipeline', '');
    writeFileSync(attributionPath, rawAttribution);
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const verdictId = '2026-05-22-eval-a2a-live-verdict';

    const result = generateA2aLiveVerdict({
      verdictId,
      rawSnapshotPath: snapshotPath,
      rawAttributionPath: attributionPath,
      harnessFeedbackRoot,
      domain,
      generatedAt: '2026-05-22T18:02:00.000Z',
      generatorCommit: 'test-commit',
    });

    assert.equal(result.packet.verdict, 'fix');
    const attribution = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'attribution.json'), 'utf8'),
    );
    assert.equal('relatedFeature' in attribution.findings[0], false);
    assert.equal('pipelineOrHuman' in attribution.findings[0].attribution, false);
  });

  it('uses a deterministic provenance timestamp when generatedAt is omitted', () => {
    const { root, snapshotPath, attributionPath } = createRawArtifacts();
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const verdictId = '2026-05-22-eval-a2a-live-verdict';

    generateA2aLiveVerdict({
      verdictId,
      rawSnapshotPath: snapshotPath,
      rawAttributionPath: attributionPath,
      harnessFeedbackRoot,
      domain,
      generatorCommit: 'test-commit',
    });

    const provenance = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'provenance.json'), 'utf8'),
    );
    assert.equal(provenance.generatedAt, '2026-05-22T18:01:00.000Z');
  });

  it('rejects unsafe verdict ids before composing output paths', () => {
    const { root, snapshotPath, attributionPath } = createRawArtifacts();
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');

    assert.throws(
      () =>
        generateA2aLiveVerdict({
          verdictId: '../escape',
          rawSnapshotPath: snapshotPath,
          rawAttributionPath: attributionPath,
          harnessFeedbackRoot,
          domain,
          generatedAt: '2026-05-22T18:02:00.000Z',
          generatorCommit: 'test-commit',
        }),
      /verdictId must be a safe slug/,
    );
  });

  it('rejects snapshot and attribution files from different eval runs', () => {
    const { root, snapshotPath, attributionPath } = createRawArtifacts();
    const staleSnapshot = readFileSync(snapshotPath, 'utf8').replace(
      'generated_at: "2026-05-22T18:00:00.000Z"',
      'generated_at: "2026-05-21T18:00:00.000Z"',
    );
    writeFileSync(snapshotPath, staleSnapshot);
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');

    assert.throws(
      () =>
        generateA2aLiveVerdict({
          verdictId: '2026-05-22-eval-a2a-live-verdict',
          rawSnapshotPath: snapshotPath,
          rawAttributionPath: attributionPath,
          harnessFeedbackRoot,
          domain,
          generatedAt: '2026-05-22T18:02:00.000Z',
          generatorCommit: 'test-commit',
        }),
      /raw artifact eval snapshot mismatch/,
    );
  });
});
