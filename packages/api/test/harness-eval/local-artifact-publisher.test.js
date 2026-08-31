import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';

function makePacket(overrides = {}) {
  return {
    id: 'hlr-20260729-abcdef12',
    domainId: 'eval:harness-ledger',
    phenomenon: 'test phenomenon',
    harnessUnderEval: { featureId: 'F257', componentId: 'ledger', name: 'Harness Ledger' },
    verdict: 'keep_observe',
    ownerAsk: 'observe',
    dailyTrend: {},
    rootCauseHypothesis: 'test',
    evidencePacket: {},
    acceptanceReevalPlan: 'test',
    counterarguments: 'none',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDomainRegistry(root) {
  const dir = join(root, 'eval-domains');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'eval-harness-ledger.yaml'),
    `---
domainId: eval:harness-ledger
displayName: Harness Ledger
systemThreadId: thread_eval_harness_ledger
evalCat:
  catId: codex
  handle: "@codex"
  model: gpt-5.6
frequency: daily
sourceAdapter: harness-ledger
sourceRefsKind: prompt-segments
enabled: true
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F257
  ownerCatId: codex
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
`,
  );
}

describe('createLocalArtifactPublisher', () => {
  let artifactRoot;

  afterEach(() => {
    if (artifactRoot) {
      rmSync(artifactRoot, { recursive: true, force: true });
      artifactRoot = undefined;
    }
  });

  it('atomically commits verdict.md and bundle/', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();

    const ref = await publisher.publishArtifact({
      packet,
      sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
      async generate(outputRoot) {
        // Existing generators write into the legacy isolated-worktree layout:
        // verdicts/<id>.md and bundles/<id>/ under docs/harness-feedback.
        const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
        const bundleDir = join(outputRoot, 'bundles', packet.id);
        mkdirSync(bundleDir, { recursive: true });
        mkdirSync(dirname(verdictPath), { recursive: true });
        writeFileSync(verdictPath, '# Verdict\n');
        writeFileSync(join(bundleDir, 'snapshot.json'), '{}');
        return { verdictPath, bundleDir };
      },
    });

    assert.equal(existsSync(ref.verdictPath), true);
    assert.equal(existsSync(ref.bundleDir), true);
    assert.equal(existsSync(join(ref.bundleDir, 'snapshot.json')), true);
    assert.equal(readFileSync(ref.verdictPath, 'utf8'), '# Verdict\n');
    assert.equal(ref.domainSlug, 'eval-harness-ledger');
    assert.equal(ref.artifactId, packet.id);
    assert.match(ref.artifactUrl, /^artifact:\/\/eval-harness-ledger\/hlr-20260729-abcdef12$/);
  });

  it('rejects duplicate artifactId with artifact_already_exists', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();
    const run = () =>
      publisher.publishArtifact({
        packet,
        sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
        async generate(outputRoot) {
          const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
          const bundleDir = join(outputRoot, 'bundles', packet.id);
          mkdirSync(bundleDir, { recursive: true });
          mkdirSync(dirname(verdictPath), { recursive: true });
          writeFileSync(verdictPath, '# Verdict\n');
          writeFileSync(join(bundleDir, 'snapshot.json'), '{}');
          return { verdictPath, bundleDir };
        },
      });

    await run();
    await assert.rejects(run(), /artifact_already_exists/);
  });

  it('rejects unsafe artifact ids before constructing filesystem paths', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    let generateCalls = 0;

    await assert.rejects(
      publisher.publishArtifact({
        packet: makePacket({ id: '../escape' }),
        sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: 'safe-run' },
        async generate() {
          generateCalls += 1;
          throw new Error('generator must not run');
        },
      }),
      /unsafe_artifact_id/,
    );

    assert.equal(generateCalls, 0, 'unsafe ids must fail before staging or generator execution');
  });

  it('rejects unsafe domain slugs before constructing filesystem paths', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    let generateCalls = 0;

    await assert.rejects(
      publisher.publishArtifact({
        packet: makePacket({ domainId: 'eval:../../escape' }),
        sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: 'safe-run' },
        async generate() {
          generateCalls += 1;
          throw new Error('generator must not run');
        },
      }),
      /unsafe_domain_slug/,
    );

    assert.equal(generateCalls, 0, 'unsafe domain slugs must fail before staging or generator execution');
  });

  it('executes afterPublish exactly once after durable commit', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();
    let afterPublishCalls = 0;

    await publisher.publishArtifact({
      packet,
      sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
      async generate(outputRoot) {
        const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
        const bundleDir = join(outputRoot, 'bundles', packet.id);
        mkdirSync(bundleDir, { recursive: true });
        mkdirSync(dirname(verdictPath), { recursive: true });
        writeFileSync(verdictPath, '# Verdict\n');
        return {
          verdictPath,
          bundleDir,
          afterPublish() {
            afterPublishCalls += 1;
          },
        };
      },
    });

    assert.equal(afterPublishCalls, 1);
  });

  it('cleans up staging directory when generator fails', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket();

    await assert.rejects(
      publisher.publishArtifact({
        packet,
        sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
        async generate() {
          throw new Error('generator failed');
        },
      }),
      /generator failed/,
    );

    const domainDir = join(artifactRoot, 'eval-harness-ledger');
    if (existsSync(domainDir)) {
      const entries = readdirSync(domainDir);
      assert.equal(
        entries.some((name) => name.startsWith('.staging-')),
        false,
        'staging dir must be removed',
      );
    }
  });

  it('rolls back committed artifact when afterPublish fails', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket({ id: 'hlr-afterpublish-fail-001' });
    const finalDir = join(artifactRoot, 'eval-harness-ledger', packet.id);

    await assert.rejects(
      publisher.publishArtifact({
        packet,
        sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
        async generate(outputRoot) {
          const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
          const bundleDir = join(outputRoot, 'bundles', packet.id);
          mkdirSync(bundleDir, { recursive: true });
          mkdirSync(dirname(verdictPath), { recursive: true });
          writeFileSync(verdictPath, '# Verdict\n');
          return {
            verdictPath,
            bundleDir,
            afterPublish() {
              throw new Error('writeback failed');
            },
          };
        },
      }),
      /artifact_publish_rollback/,
    );

    assert.equal(existsSync(finalDir), false, 'artifact must be rolled back after afterPublish failure');
  });

  it('preserves typed domain errors from afterPublish while rolling back', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket({ id: 'hlr-domain-error-001' });
    const finalDir = join(artifactRoot, 'eval-harness-ledger', packet.id);

    await assert.rejects(
      publisher.publishArtifact({
        packet,
        sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
        async generate(outputRoot) {
          const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
          const bundleDir = join(outputRoot, 'bundles', packet.id);
          mkdirSync(bundleDir, { recursive: true });
          mkdirSync(dirname(verdictPath), { recursive: true });
          writeFileSync(verdictPath, '# Verdict\n');
          return {
            verdictPath,
            bundleDir,
            afterPublish() {
              throw new Error('invalid_episode_verdict_writeback: stale claim');
            },
          };
        },
      }),
      /invalid_episode_verdict_writeback: stale claim/,
    );

    assert.equal(existsSync(finalDir), false, 'artifact must be rolled back after afterPublish domain error');
  });

  it('normalizes concurrent duplicate publish race to artifact_already_exists', async () => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'artifact-store-'));
    const publisher = createLocalArtifactPublisher({ artifactRoot });
    const packet = makePacket({ id: 'hlr-concurrent-001' });

    const generate = async (outputRoot) => {
      // Yield the event loop so both publishers pass the initial existsSync
      // check before either reaches the atomic rename, forcing the OS-level
      // EEXIST/ENOTEMPTY race path.
      await new Promise((r) => setTimeout(r, 10));
      const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
      const bundleDir = join(outputRoot, 'bundles', packet.id);
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(dirname(verdictPath), { recursive: true });
      writeFileSync(verdictPath, '# Verdict\n');
      return { verdictPath, bundleDir };
    };

    const opts = {
      packet,
      sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
      generate,
    };

    const [a, b] = await Promise.allSettled([publisher.publishArtifact(opts), publisher.publishArtifact(opts)]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'exactly one concurrent publish must succeed');
    assert.equal(rejected.length, 1, 'exactly one concurrent publish must fail');
    assert.match(
      rejected[0].reason instanceof Error ? rejected[0].reason.message : String(rejected[0].reason),
      /artifact_already_exists/,
      'the loser must be normalized to artifact_already_exists',
    );
  });
});
describe('local artifact store + Eval Hub read-model', () => {
  let tmp;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it('loadEvalHubSummary surfaces artifact-store verdicts', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'eval-hub-artifact-'));
    const harnessFeedbackRoot = join(tmp, 'docs', 'harness-feedback');
    const artifactStoreRoot = join(tmp, 'data', 'harness-feedback', 'artifacts');
    makeDomainRegistry(harnessFeedbackRoot);

    const publisher = createLocalArtifactPublisher({ artifactRoot: artifactStoreRoot });
    const packet = makePacket({ id: 'hlr-roundtrip-001' });
    await publisher.publishArtifact({
      packet,
      sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
      async generate(outputRoot) {
        const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
        const bundleDir = join(outputRoot, 'bundles', packet.id);
        mkdirSync(bundleDir, { recursive: true });
        mkdirSync(dirname(verdictPath), { recursive: true });
        writeFileSync(
          verdictPath,
          `---
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: ${packet.id}
---

# Verdict

- Verdict: \`keep_observe\`
- Phenomenon: test
- Owner ask: observe
- Harness: F257/ledger (Harness Ledger)
- Re-eval: 2099-01-01T00:00:00.000Z

Evidence:
- metric:test
`,
        );
        const verdictId = packet.id;
        const evalSnapshotId = 'eval-F257-2026-07-29';
        writeFileSync(
          join(bundleDir, 'snapshot.json'),
          JSON.stringify(
            {
              verdictId,
              evalSnapshotId,
              featureId: 'F257',
              generatedAt: '2099-01-01T00:00:00.000Z',
              window: { startMs: 1, endMs: 2, durationHours: 0 },
              components: [
                {
                  componentId: 'C1',
                  componentName: 'test component',
                  confidence: 'medium',
                  activationCounts: { 'test.metric': 1 },
                  frictionCounts: {},
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(
          join(bundleDir, 'attribution.json'),
          JSON.stringify(
            {
              verdictId,
              featureId: 'F257',
              evalSnapshotId,
              generatedAt: '2099-01-01T00:00:00.000Z',
              findings: [
                {
                  id: 'F-001',
                  frictionSignal: { type: 'test', severity: 'low', confidence: 0.5 },
                  attribution: {
                    primaryLayer: 'test-layer',
                    evidence: [
                      {
                        type: 'counter',
                        anchor: 'C1/test.metric',
                        excerpt: 'test evidence',
                      },
                    ],
                  },
                  proposedAction: [
                    {
                      action: 'observe',
                      target: 'test',
                      rationale: 'test',
                    },
                  ],
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(
          join(bundleDir, 'provenance.json'),
          JSON.stringify(
            {
              verdictId,
              generatedAt: '2099-01-01T00:00:00.000Z',
              rawInputs: [
                {
                  path: 'test-input',
                  sha256: '0000000000000000000000000000000000000000000000000000000000000000',
                },
              ],
              generator: { name: 'test', version: '1.0.0' },
              sanitizeRulesVersion: '1.0.0',
            },
            null,
            2,
          ),
        );
        return { verdictPath, bundleDir };
      },
    });

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      artifactStoreRoot,
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    assert.equal(summary.items.length, 1);
    const item = summary.items[0];
    assert.equal(item.id, packet.id);
    assert.equal(item.verdict, 'keep_observe');
    assert.equal(
      item.source.verdictPath,
      'data/harness-feedback/artifacts/eval-harness-ledger/hlr-roundtrip-001/docs/harness-feedback/verdicts/hlr-roundtrip-001.md',
    );
    assert.equal(
      item.source.bundleDir,
      'data/harness-feedback/artifacts/eval-harness-ledger/hlr-roundtrip-001/docs/harness-feedback/bundles/hlr-roundtrip-001',
    );
  });
});
