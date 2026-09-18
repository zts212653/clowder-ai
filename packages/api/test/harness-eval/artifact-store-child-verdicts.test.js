import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { listOwnerArtifactVerdicts } from '../../dist/infrastructure/harness-eval/artifact-store/artifact-store-reader.js';
import { deriveFrictionChildVerdictId } from '../../dist/infrastructure/harness-eval/friction/friction-finding-artifact.js';
import { buildFrictionRollupReport } from '../../dist/infrastructure/harness-eval/friction/friction-rollup-report.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createFrictionGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import {
  hubReadableGenerator,
  makeHarnessLedgerDomainRegistry,
  makePacket,
  publishOpts,
} from './local-artifact-publisher-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * F257 — an artifact is a container, not a verdict.
 *
 * A publication can generate more than one verdict: a friction breakout writes one
 * child verdict per actionable finding next to its aggregate verdict, all inside the
 * single artifact directory named after the aggregate. The reader used to open only
 * the verdict named like its container, so every child was published and then never
 * seen again. A verdict is addressed by (artifact, verdict), and both halves count.
 */

async function buildHubApp(harnessFeedbackRoot, artifactStoreRoot, sessionUserId) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = sessionUserId;
  });
  await app.register(evalHubRoutes, { harnessFeedbackRoot, artifactStoreRoot });
  return app;
}

const fileUrl = (artifactId, verdictId, fileKey, domainSlug = 'eval-harness-ledger') =>
  `/api/eval-hub/artifacts/${domainSlug}/${artifactId}/verdicts/${verdictId}/files/${fileKey}`;

describe('artifact store child verdicts', () => {
  let tmp;
  let harnessFeedbackRoot;
  let artifactStoreRoot;
  const now = new Date('2099-01-01T00:00:00.000Z');

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artifact-child-verdicts-'));
    harnessFeedbackRoot = join(tmp, 'repo', 'docs', 'harness-feedback');
    artifactStoreRoot = join(tmp, 'data', 'harness-feedback', 'artifacts');
    makeHarnessLedgerDomainRegistry(harnessFeedbackRoot);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function publishWithChildren(owner, parentId, children) {
    const packet = makePacket({ id: parentId });
    const publisher = createLocalArtifactPublisher({ artifactRoot: artifactStoreRoot });
    return publisher.publishArtifact(
      publishOpts(packet, hubReadableGenerator(packet, { phenomenon: `parent ${parentId}`, children }), owner),
    );
  }

  it('lists every verdict of an artifact, each addressed by its artifact and its own id', async () => {
    await publishWithChildren('owner-a', 'hlr-parent', [
      { id: 'hlr-parent-child-1', phenomenon: 'first finding' },
      { id: 'hlr-parent-child-2', phenomenon: 'second finding' },
    ]);

    const listed = listOwnerArtifactVerdicts(artifactStoreRoot, 'owner-a').map((entry) => entry.coordinates);
    assert.deepEqual(listed, [
      { domainSlug: 'eval-harness-ledger', artifactId: 'hlr-parent', verdictId: 'hlr-parent' },
      { domainSlug: 'eval-harness-ledger', artifactId: 'hlr-parent', verdictId: 'hlr-parent-child-1' },
      { domainSlug: 'eval-harness-ledger', artifactId: 'hlr-parent', verdictId: 'hlr-parent-child-2' },
    ]);
  });

  it('shows child verdicts in the Eval Hub with their own content', async () => {
    await publishWithChildren('owner-a', 'hlr-parent', [{ id: 'hlr-parent-child', phenomenon: 'the child finding' }]);

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      artifactStore: { root: artifactStoreRoot, ownerUserId: 'owner-a' },
      now,
    });
    const byId = new Map(summary.items.map((item) => [item.id, item]));
    assert.deepEqual([...byId.keys()].sort(), ['hlr-parent', 'hlr-parent-child']);
    assert.equal(byId.get('hlr-parent-child').phenomenon, 'the child finding');
    assert.equal(byId.get('hlr-parent').phenomenon, 'parent hlr-parent');
    assert.deepEqual(byId.get('hlr-parent-child').source, {
      kind: 'artifact',
      domainSlug: 'eval-harness-ledger',
      artifactId: 'hlr-parent',
      verdictId: 'hlr-parent-child',
    });
    assert.equal(summary.counts.total, 2);
  });

  it('serves a child verdict’s own files from inside its artifact', async (t) => {
    await publishWithChildren('owner-a', 'hlr-parent', [{ id: 'hlr-parent-child', phenomenon: 'the child finding' }]);
    await publishWithChildren('owner-a', 'hlr-other', []);
    const app = await buildHubApp(harnessFeedbackRoot, artifactStoreRoot, 'owner-a');
    t.after(() => app.close());

    const verdict = await app.inject({ method: 'GET', url: fileUrl('hlr-parent', 'hlr-parent-child', 'verdict') });
    assert.equal(verdict.statusCode, 200, verdict.body);
    assert.match(verdict.json().content, /Phenomenon: the child finding/);

    const snapshot = await app.inject({ method: 'GET', url: fileUrl('hlr-parent', 'hlr-parent-child', 'snapshot') });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.equal(JSON.parse(snapshot.json().content).verdictId, 'hlr-parent-child');

    const parent = await app.inject({ method: 'GET', url: fileUrl('hlr-parent', 'hlr-parent', 'verdict') });
    assert.match(parent.json().content, /Phenomenon: parent hlr-parent/);

    const wrongArtifact = await app.inject({ method: 'GET', url: fileUrl('hlr-other', 'hlr-parent-child', 'verdict') });
    assert.equal(wrongArtifact.statusCode, 404, 'a verdict is only reachable through the artifact that holds it');
  });

  it('answers another owner’s child verdict exactly like a missing one', async (t) => {
    await publishWithChildren('owner-a', 'hlr-parent', [{ id: 'hlr-parent-child' }]);
    const app = await buildHubApp(harnessFeedbackRoot, artifactStoreRoot, 'owner-b');
    t.after(() => app.close());

    const other = await app.inject({ method: 'GET', url: fileUrl('hlr-parent', 'hlr-parent-child', 'verdict') });
    const missing = await app.inject({ method: 'GET', url: fileUrl('hlr-parent', 'hlr-missing', 'verdict') });
    assert.equal(other.statusCode, 404);
    assert.deepEqual(other.json(), missing.json());
  });

  it('rejects a verdict reference that is not a single safe segment', async (t) => {
    const app = await buildHubApp(harnessFeedbackRoot, artifactStoreRoot, 'owner-a');
    t.after(() => app.close());
    for (const bad of ['.staging-x', '%2E%2E%2Fescape']) {
      const response = await app.inject({ method: 'GET', url: fileUrl('hlr-parent', bad, 'verdict') });
      assert.equal(response.statusCode, 400, `${bad} → ${response.body}`);
    }
  });
});

const FRICTION_CAPTURE = JSON.parse(
  readFileSync(new URL('../fixtures/harness-eval/f313/three-candidate-friction-capture.json', import.meta.url), 'utf8'),
);

const FRICTION_YAML = `domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat: { catId: gpt52, handle: '@gpt52', model: gpt-5.4 }
frequency: weekly
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [longitudinal-analysis, verdict-discussion] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F245, ownerCatId: opus-47, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
enabled: true
`;

function frictionJudgment(candidateRef, findingKey, featureId) {
  const sourceSignalRefs = FRICTION_CAPTURE.rollupInput.clusters
    .find((cluster) => cluster.clusterId === candidateRef)
    .members.map((member) => `source-message:${member.rawRef}`);
  return {
    candidateRef,
    findingKey,
    analysisDisposition: 'observe',
    approvalRequirement: { kind: 'not_required' },
    rationale: `Typed analysis for ${candidateRef}.`,
    uncertainty: 'medium',
    falsifier: { condition: `Candidate ${candidateRef} disappears.`, evidenceRef: `falsifier:${candidateRef}` },
    withdrawalCondition: `Withdraw when ${candidateRef} no longer reproduces.`,
    measurementResultRef: `measurement:f267/${candidateRef}`,
    sourceSignalRefs,
    repairTargetHint: { featureId },
  };
}

const FRICTION_TARGET_OWNERS = { F188: 'codex-sol', F203: 'opus-47', F167: 'codex-terra' };
const frictionTargetResolver = {
  async resolve({ hint, resolvedAt }) {
    const ownerCatId = FRICTION_TARGET_OWNERS[hint.featureId];
    const resolutionRef = `feature-thread-owner:v1:${hint.featureId}:thread_${hint.featureId.toLowerCase()}:${ownerCatId}`;
    const digest = createHash('sha256').update(`${hint.featureId}${ownerCatId}${resolutionRef}`).digest('hex');
    return {
      status: 'resolved',
      target: {
        featureId: hint.featureId,
        ownerCatId,
        version: `repair-target-v1-${digest}`,
        resolutionRef,
        resolvedAt,
      },
    };
  },
};

describe('friction breakout through the real artifact store', () => {
  let harnessFeedbackRoot;
  let artifactStoreRoot;

  beforeEach(() => {
    harnessFeedbackRoot = setupHarnessFeedback();
    writeFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-friction.yaml'), FRICTION_YAML);
    artifactStoreRoot = mkdtempSync(join(tmpdir(), 'artifact-friction-breakout-'));
  });

  afterEach(() => {
    rmSync(harnessFeedbackRoot, { recursive: true, force: true });
    rmSync(artifactStoreRoot, { recursive: true, force: true });
  });

  const aggregate = buildPacket({
    id: 'friction-breakout-aggregate',
    domainId: 'eval:friction',
    createdAt: FRICTION_CAPTURE.capturedAt,
    verdict: 'keep_observe',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    ownerAsk: { targetFeatureId: 'F245', targetOwnerCatId: 'opus-47', requestedAction: 'Observe aggregate window.' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: ['friction.cluster_count'],
      sampleTraceRefs: ['source-message:f313'],
    },
  });

  function publishBreakout() {
    const capture = {
      capturedAt: FRICTION_CAPTURE.capturedAt,
      expectedCancelIds: [],
      channelCaptures: {
        'paw-feel': { status: 'ok', emittedIds: FRICTION_CAPTURE.rollupInput.signals.map((signal) => signal.id) },
        cancel: { status: 'ok', emittedIds: [] },
        'user-feedback': { status: 'ok', emittedIds: [] },
        'eval-domain': { status: 'ok', emittedIds: [] },
      },
      rollupInput: FRICTION_CAPTURE.rollupInput,
      rollupReport: buildFrictionRollupReport(FRICTION_CAPTURE.rollupInput, FRICTION_CAPTURE.capturedAt),
    };
    return handlePublishVerdict(
      {
        harnessFeedbackRoot,
        artifactPublisher: createLocalArtifactPublisher({ artifactRoot: artifactStoreRoot }),
        generator: createFrictionGeneratorAdapter({ resolve: async () => capture }, frictionTargetResolver),
        now: () => new Date(FRICTION_CAPTURE.capturedAt),
      },
      {
        packet: aggregate,
        domain: 'eval:friction',
        catId: 'gpt52',
        ownerUserId: 'user-1',
        sourceRefs: FRICTION_CAPTURE.selector,
        analysisFindings: [
          frictionJudgment('9028c961c203', 'evidence-reader-drilldown-path', 'F188'),
          frictionJudgment('04eaba997290', 'default-mode-tool-availability', 'F203'),
          frictionJudgment('1193e4fa241b', 'a2a-disposition-source-mismatch', 'F167'),
        ],
      },
    );
  }

  it('refuses a child verdict whose id a verdict committed to the repository already uses', async () => {
    // The Eval Hub merges repository and runtime verdicts by id, so a committed id is taken for children too.
    const childId = deriveFrictionChildVerdictId(aggregate.id, 'default-mode-tool-availability');
    writeFileSync(join(harnessFeedbackRoot, 'verdicts', `${childId}.md`), '# committed verdict\n');

    const result = await publishBreakout();
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(result.error, 'verdict_already_exists');
    assert.match(result.detail, new RegExp(`^verdict_id_taken: .*'${childId}'`));
    assert.deepEqual(listOwnerArtifactVerdicts(artifactStoreRoot, 'user-1'), [], 'nothing was published');
  });

  it('publishes child verdicts the Eval Hub lists and whose evidence it can open', async (t) => {
    const result = await publishBreakout();
    assert.ok(!('error' in result), JSON.stringify(result));
    const childIds = result.childArtifacts.map((child) => child.verdictId).sort();
    assert.equal(childIds.length, 3);

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      artifactStore: { root: artifactStoreRoot, ownerUserId: 'user-1' },
      now: new Date(FRICTION_CAPTURE.capturedAt),
    });
    const listed = summary.items.map((item) => item.id).sort();
    assert.deepEqual(listed, [aggregate.id, ...childIds].sort(), 'every published verdict reaches the Hub');

    const child = summary.items.find((item) => item.id === childIds[0]);
    assert.deepEqual(child.source, {
      kind: 'artifact',
      domainSlug: 'eval-friction',
      artifactId: aggregate.id,
      verdictId: childIds[0],
    });

    const app = await buildHubApp(harnessFeedbackRoot, artifactStoreRoot, 'user-1');
    t.after(() => app.close());
    const snapshot = await app.inject({
      method: 'GET',
      url: fileUrl(aggregate.id, childIds[0], 'snapshot', 'eval-friction'),
    });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.equal(JSON.parse(snapshot.json().content).verdictId, childIds[0]);
  });
});
