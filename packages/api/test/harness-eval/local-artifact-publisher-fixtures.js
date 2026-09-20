/**
 * F257 local artifact store — shared fixtures for the publisher, integrity and
 * owner-scope suites. Kept out of the `.test.js` files so importing a helper never
 * registers another suite's tests.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const OWNER = 'owner-a';

export function makePacket(overrides = {}) {
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

/** The layout pinned independently of the implementation: owners/<sha256(owner)>/<domainSlug>/<artifactId>. */
export function expectedArtifactDir(artifactRoot, owner, domainSlug, artifactId) {
  const ownerKey = createHash('sha256').update(owner, 'utf8').digest('hex');
  return join(artifactRoot, 'owners', ownerKey, domainSlug, artifactId);
}

/** A generator that writes the canonical verdict and bundle, then returns their coordinates. */
export function writingGenerator(packet, extra = {}) {
  return async (outputRoot) => {
    const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
    const bundleDir = join(outputRoot, 'bundles', packet.id);
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(dirname(verdictPath), { recursive: true });
    writeFileSync(verdictPath, extra.verdictBody ?? '# Verdict\n');
    writeFileSync(join(bundleDir, 'snapshot.json'), extra.snapshotBody ?? '{}');
    return { verdictPath, bundleDir, ...(extra.afterPublish ? { afterPublish: extra.afterPublish } : {}) };
  };
}

export function publishOpts(packet, generate, ownerUserId = OWNER) {
  return {
    packet,
    ownerUserId,
    sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
    generate,
  };
}

export function makeHarnessLedgerDomainRegistry(harnessFeedbackRoot) {
  const dir = join(harnessFeedbackRoot, 'eval-domains');
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** An immutable lifecycle root for a harness-ledger verdict, as the publish handler writes it into the bundle. */
export function lifecycleRoot(verdictId, overrides = {}) {
  return {
    schemaVersion: 1,
    verdictId,
    domainId: 'eval:harness-ledger',
    createdAt: '2099-01-01T00:00:00.000Z',
    verdict: 'fix',
    harnessUnderEval: { featureId: 'F257', componentId: 'ledger', name: 'Harness Ledger' },
    ownerAsk: { targetFeatureId: 'F257', targetOwnerCatId: 'codex', requestedAction: 'repair the ledger' },
    acceptanceReevalPlan: {
      nextEvalAt: '2099-01-08T00:00:00.000Z',
      closureCondition: 'the next eval verifies the repair',
    },
    ...overrides,
  };
}

function writeHubReadableVerdict(outputRoot, { verdictId, domainId, phenomenon, verdict, root }) {
  const evalSnapshotId = 'eval-F257-2026-07-29';
  const generatedAt = '2099-01-01T00:00:00.000Z';
  const verdictPath = join(outputRoot, 'verdicts', `${verdictId}.md`);
  const bundleDir = join(outputRoot, 'bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(dirname(verdictPath), { recursive: true });
  writeFileSync(
    verdictPath,
    `---
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: ${domainId}
packet_id: ${verdictId}
---

# Verdict

- Verdict: \`${verdict}\`
- Phenomenon: ${phenomenon}
- Owner ask: observe
- Harness: F257/ledger (Harness Ledger)
- Re-eval: ${generatedAt}

Evidence:
- metric:test
`,
  );
  writeJson(join(bundleDir, 'snapshot.json'), {
    verdictId,
    evalSnapshotId,
    featureId: 'F257',
    generatedAt,
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
  });
  writeJson(join(bundleDir, 'attribution.json'), {
    verdictId,
    featureId: 'F257',
    evalSnapshotId,
    generatedAt,
    findings: [],
    noFindingRecord: { reason: 'fixture', evidence: 'fixture' },
  });
  writeJson(join(bundleDir, 'provenance.json'), {
    verdictId,
    generatedAt,
    rawInputs: [{ path: 'test-input', sha256: '0'.repeat(64) }],
    generator: { name: 'test', version: '1.0.0' },
    sanitizeRulesVersion: '1.0.0',
  });
  if (root) writeJson(join(bundleDir, 'lifecycle-root.json'), root);
  return { verdictPath, bundleDir };
}

/**
 * A generator whose output the Eval Hub read model can render (verdict + snapshot/attribution/provenance).
 * `lifecycleRoot` adds the immutable lifecycle root; `children` are further verdicts generated into the
 * same artifact, the way a friction breakout publishes its findings next to the aggregate verdict.
 */
export function hubReadableGenerator(
  packet,
  { phenomenon = 'test', verdict = 'keep_observe', lifecycleRoot: root, children = [] } = {},
) {
  return async (outputRoot) => {
    const published = writeHubReadableVerdict(outputRoot, {
      verdictId: packet.id,
      domainId: packet.domainId,
      phenomenon,
      verdict,
      root,
    });
    const childArtifacts = children.map((child) => ({
      verdictId: child.id,
      ...writeHubReadableVerdict(outputRoot, {
        verdictId: child.id,
        domainId: packet.domainId,
        phenomenon: child.phenomenon ?? 'child',
        verdict: child.verdict ?? 'keep_observe',
        root: child.lifecycleRoot,
      }),
    }));
    return { ...published, ...(childArtifacts.length > 0 ? { childArtifacts } : {}) };
  };
}
