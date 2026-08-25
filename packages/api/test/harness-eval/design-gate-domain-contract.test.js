import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import {
  parseEvalDomainRegistryFile,
  parseEvalMetricGlossary,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import { buildEvalCatInvocation } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

function yaml(relativePath) {
  return parse(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
}

const validityRefKeys = ['certificateRef', 'resultRef', 'replayRef'];

function assertIndependentValidity(designGateValidity, sopValidity) {
  const designGateValidityRefs = validityRefKeys.map((refKey) => designGateValidity[refKey]);
  const sopValidityRefs = validityRefKeys.map((refKey) => sopValidity[refKey]);
  const isFailClosedPublicBootstrap = [...designGateValidityRefs, ...sopValidityRefs].every((ref) => ref === null);
  if (isFailClosedPublicBootstrap) {
    assert.equal(designGateValidity.status, 'unmigrated');
    assert.equal(sopValidity.status, 'unmigrated');
    return;
  }
  for (const refKey of validityRefKeys) {
    assert.notEqual(designGateValidity[refKey], sopValidity[refKey]);
  }
}

test('eval:design-gate owns an independent source adapter, consumer, and six-field vector', () => {
  const domain = parseEvalDomainRegistryFile(yaml('docs/harness-feedback/eval-domains/eval-design-gate.yaml'));
  const glossary = parseEvalMetricGlossary(yaml('docs/harness-feedback/eval-domains/eval-design-gate.metrics.yaml'));
  const sop = parseEvalDomainRegistryFile(yaml('docs/harness-feedback/eval-domains/eval-sop.yaml'));
  const census = yaml('docs/harness-feedback/registry/measurement-bundles.yaml');
  const entry = census.entries.find((candidate) => candidate.domainId === 'eval:design-gate');
  const sopEntry = census.entries.find((candidate) => candidate.domainId === 'eval:sop');

  assert.equal(domain.enabled, true);
  assert.equal(domain.sourceAdapter, 'f303-design-gate-episode');
  assert.equal(domain.sourceRefsKind, 'design-gate-episode-source-map');
  assert.equal(domain.handoffTargetResolver.featureId, 'F303');
  assert.equal(domain.handoffTargetResolver.ownerCatId, 'codex-sol');
  assert.notEqual(domain.sourceAdapter, sop.sourceAdapter);
  assert.notEqual(domain.sourceRefsKind, sop.sourceRefsKind);
  assert.notEqual(domain.handoffTargetResolver.ownerCatId, sop.handoffTargetResolver.ownerCatId);
  assert.notEqual(domain.evalCat.catId, sop.evalCat.catId);
  assert.equal(domain.threadPolicy.stateSot, 'registry');
  assert.equal(sop.threadPolicy.stateSot, 'registry');

  assert.deepEqual(Object.keys(glossary), [
    'eligible_episodes',
    'pre_review_unique_catches',
    'post_merge_divergence_escapes',
    'false_positive_blocks',
    'extra_active_minutes',
    'extra_review_rounds',
  ]);
  assert.equal(
    Object.keys(glossary).some((metric) => metric.includes('score')),
    false,
  );

  assert.equal(entry.sourceSelector.adapter, domain.sourceAdapter);
  assert.equal(entry.sourceSelector.kind, domain.sourceRefsKind);
  assert.equal(entry.decisionConsumer.featureId, 'F303');
  assert.equal(entry.decisionConsumer.ownerCatId, 'codex-sol');
  assert.equal(entry.validityMigration.actionGate, 'keep_observe_only');
  assertIndependentValidity(entry.validityMigration, sopEntry.validityMigration);

  const invocation = buildEvalCatInvocation({
    domain,
    trendRefs: [],
    verdictRefs: [],
    legacyCleanup: { status: 'not_checked' },
  });
  assert.match(invocation.instructions, /source-maps/);
  assert.match(invocation.instructions, /window\.endMs/);
  assert.match(invocation.instructions, /cumulative/i);
  assert.doesNotMatch(invocation.instructions, /sourceMapId": "f303-phase-c-pr3901"/);
});

test('public bootstrap keeps missing design-gate and SOP validity fail-closed', () => {
  const publicUnmigratedValidity = {
    status: 'unmigrated',
    certificateRef: null,
    resultRef: null,
    replayRef: null,
  };

  assert.doesNotThrow(() =>
    assertIndependentValidity({ ...publicUnmigratedValidity }, { ...publicUnmigratedValidity }),
  );
});

test('design-gate validity still cannot reuse SOP evidence after certification', () => {
  assert.throws(() =>
    assertIndependentValidity(
      {
        status: 'contract_ready',
        certificateRef: 'same-certificate',
        resultRef: 'design-gate-result',
        replayRef: 'design-gate-replay',
      },
      {
        status: 'certified_insufficient',
        certificateRef: 'same-certificate',
        resultRef: 'sop-result',
        replayRef: 'sop-replay',
      },
    ),
  );
});
