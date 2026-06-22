import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createFrictionGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * F245 Phase C PR1b — publish_verdict eval:friction end-to-end test (L4).
 *
 * Mirrors publish-verdict-memory.test.js. Validates:
 *   - Handler accepts eval:friction + friction-rollup-snapshot sourceRefs
 *   - Handler dispatches to the friction generator adapter via deps.generator
 *   - sourceRefs.kind ↔ packet.domainId cross-check enforces
 *     'friction-rollup-snapshot' for eval:friction (and rejects mismatches)
 *   - Adapter resolves a rollup via provider port → writes
 *     snapshot.json / attribution.json / provenance.json + raw report + verdict.md
 *     inside the isolated worktree
 *   - 501 still returned when domain has no generator wired
 *
 * NOTE: setupHarnessFeedback seeds 5 domains WITHOUT friction, so this test
 * inline-seeds eval-friction.yaml into both the live root and the isolated stub.
 */

const FRICTION_YAML = `domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat:
  catId: gpt52
  handle: '@gpt52'
  model: gpt-5.4
frequency: weekly
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F245
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
enabled: true
`;

/** @type {string} */
let root;

before(() => {
  root = setupHarnessFeedback();
  writeFileSync(join(root, 'eval-domains', 'eval-friction.yaml'), FRICTION_YAML);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildFrictionPacket(overrides = {}) {
  return buildPacket({
    id: 'vhp-friction-e2e-test',
    domainId: 'eval:friction',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    ownerAsk: { targetFeatureId: 'F245', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    evidencePacket: {
      snapshotRefs: ['placeholder:will-be-overridden'],
      attributionRefs: ['placeholder:will-be-overridden'],
      metricRefs: ['friction.cluster_count'],
      sampleTraceRefs: ['friction:trace-001'],
    },
    ...overrides,
  });
}

function buildRollupInput({ clusters = 1 } = {}) {
  const signals = [];
  const clusterList = [];
  for (let i = 0; i < clusters; i++) {
    const signalId = `paw-feel:m${i}#0`;
    signals.push({
      id: signalId,
      channel: 'paw-feel',
      timestamp: '2026-06-19T00:00:00.000Z',
      tool: `tool-${i}`,
      symptom: `symptom ${i}`,
      rawRef: `m${i}#0`,
      severity: 'high',
    });
    clusterList.push({
      clusterId: `clu${i}`,
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
    degraded: false,
    droppedChannels: [],
  };
}

const SELECTOR = {
  kind: 'friction-rollup-snapshot',
  windowStartMs: 1_780_000_000_000,
  windowEndMs: 1_780_600_000_000,
};

describe('handlePublishVerdict end-to-end with eval:friction generator', () => {
  it('happy path: handler dispatches to friction adapter, returns verdict path + commit/PR', async () => {
    const provider = { resolve: async () => buildRollupInput({ clusters: 2 }) };
    const generator = createFrictionGeneratorAdapter(provider);

    let isoStub;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        isoStub = join(root, '..', 'friction-e2e-iso-stub');
        rmSync(isoStub, { recursive: true, force: true });
        mkdirSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(join(isoStub, 'docs', 'harness-feedback', 'eval-domains', 'eval-friction.yaml'), FRICTION_YAML);
        await opts.stage(isoStub);
        return { commitSha: 'friction-sha-1234', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9200' };
      },
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator },
      {
        packet: buildFrictionPacket(),
        domain: 'eval:friction',
        catId: 'gpt52',
        sourceRefs: SELECTOR,
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.commitSha, 'friction-sha-1234');
    assert.equal(result.verdictPath, 'docs/harness-feedback/verdicts/vhp-friction-e2e-test.md');
    assert.equal(result.bundleDir, 'docs/harness-feedback/bundles/vhp-friction-e2e-test');

    const isoBundle = join(isoStub, 'docs', 'harness-feedback', 'bundles', 'vhp-friction-e2e-test');
    assert.ok(existsSync(join(isoBundle, 'snapshot.json')), 'snapshot.json must be written');
    assert.ok(existsSync(join(isoBundle, 'attribution.json')), 'attribution.json must be written');
    assert.ok(existsSync(join(isoBundle, 'provenance.json')), 'provenance.json must be written');
    assert.ok(existsSync(join(isoBundle, 'raw', 'rollup-report.json')), 'raw rollup report must be written');

    const snapshot = JSON.parse(readFileSync(join(isoBundle, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.featureId, 'F245');
    assert.equal(snapshot.verdictId, 'vhp-friction-e2e-test');

    const provenance = JSON.parse(readFileSync(join(isoBundle, 'provenance.json'), 'utf8'));
    assert.equal(provenance.generator.name, 'eval-friction-live-verdict');
    assert.match(provenance.rawInputs[0].sha256, /^[0-9a-f]{64}$/);

    const isoVerdict = join(isoStub, 'docs', 'harness-feedback', 'verdicts', 'vhp-friction-e2e-test.md');
    const md = readFileSync(isoVerdict, 'utf8');
    assert.match(md, /vhp-friction-e2e-test/);
    assert.match(md, /keep_observe/);
    assert.match(md, /domain_id: eval:friction/);

    rmSync(isoStub, { recursive: true, force: true });
  });

  it('returns 400 sourceRefs_kind_mismatch when eval:friction gets a2a refs', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const generator = createFrictionGeneratorAdapter(provider);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator },
      {
        packet: buildFrictionPacket({ id: 'vhp-friction-kindmismatch' }),
        domain: 'eval:friction',
        catId: 'gpt52',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
    assert.match(result.detail, /eval:friction/);
    assert.match(result.detail, /friction-rollup-snapshot/);
  });

  it('returns 400 sourceRefs_kind_mismatch when friction-rollup-snapshot used for eval:a2a', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const generator = createFrictionGeneratorAdapter(provider);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator },
      {
        packet: buildPacket({ id: 'vhp-friction-wrong-domain', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: SELECTOR,
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'sourceRefs_kind_mismatch');
  });

  it('returns 400 invalid_source_ref when window is malformed (windowEndMs <= windowStartMs)', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const generator = createFrictionGeneratorAdapter(provider);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator },
      {
        packet: buildFrictionPacket({ id: 'vhp-friction-badwindow' }),
        domain: 'eval:friction',
        catId: 'gpt52',
        sourceRefs: { kind: 'friction-rollup-snapshot', windowStartMs: 100, windowEndMs: 100 },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_source_ref');
    assert.match(result.detail, /windowEndMs/);
  });

  it('returns 501 when no friction generator wired (route-layer SoT)', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root /* generator omitted */ },
      {
        packet: buildFrictionPacket({ id: 'vhp-friction-no-gen' }),
        domain: 'eval:friction',
        catId: 'gpt52',
        sourceRefs: SELECTOR,
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 501);
    assert.equal(result.error, 'unsupported_generator');
    assert.match(result.detail, /eval:friction/);
  });

  it('returns 403 not_allowed when catId is not the friction eval cat', async () => {
    const provider = { resolve: async () => buildRollupInput() };
    const generator = createFrictionGeneratorAdapter(provider);

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, generator },
      {
        packet: buildFrictionPacket({ id: 'vhp-friction-wrongcat' }),
        domain: 'eval:friction',
        catId: 'opus-47', // friction eval cat is gpt52
        sourceRefs: SELECTOR,
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'not_allowed');
  });
});
