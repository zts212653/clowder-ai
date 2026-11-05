import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const domainSource = fileURLToPath(new URL('../../../../docs/harness-feedback/eval-domains', import.meta.url));
export const fixtureVerdictId = 'fixture-a2a-observed-window';
export const fixturePacketId = 'vhp_fixture_a2a_observed_window';
export const fixtureOtherRef = 'Fixture evidence: A2A parser boundary.';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Copy shipped registry definitions, never installation verdicts or bundles.
export function createEvalHubRoot(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'f330-eval-hub-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const root = join(repoRoot, 'docs/harness-feedback');
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  for (const file of readdirSync(domainSource)) {
    if (/\.ya?ml$/.test(file)) copyFileSync(join(domainSource, file), join(root, 'eval-domains', file));
  }
  return root;
}

export function writeEvalHubVerdict(
  root,
  {
    verdictId = fixtureVerdictId,
    domainId = 'eval:a2a',
    packetId = `vhp_${verdictId.replaceAll('-', '_')}`,
    featureId = 'F167',
    componentId = 'C1',
    componentName = 'hold_ball (MCP tool)',
    verdict = 'keep_observe',
    generatedAt = '2026-05-23T03:00:00.000Z',
    nextEvalAt = '2026-05-26T03:12:57.174Z',
    durationHours = 12.5,
    components = [
      {
        id: componentId,
        name: componentName,
        activationCounts: { hold_count: 7 },
        frictionCounts: { 'c1.zombie_hold_count': 0 },
        confidence: 'medium',
      },
    ],
    otherRef = fixtureOtherRef,
  } = {},
) {
  const bundle = join(root, 'bundles', verdictId);
  const snapshotId = `eval-${featureId}-${verdictId}`;
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(root, 'verdicts', `${verdictId}.md`),
    `---
feedback_type: live-verdict
domain_id: ${domainId}
packet_id: ${packetId}
---

# Fixture verdict — ${verdictId}

- Verdict: \`${verdict}\`
- Phenomenon: No actionable A2A findings: fixture observation
- Harness: ${featureId}/${componentId} (${componentName})
- Owner ask: No action required; keep observing.
- Re-eval: next eval at ${nextEvalAt}

Evidence:
- snapshot:bundle/${verdictId}/snapshot
- attribution:bundle/${verdictId}/${snapshotId}:no-finding
- metric:c1.zombie_hold_count
- ${otherRef}
`,
  );
  writeJson(join(bundle, 'snapshot.json'), {
    verdictId,
    evalSnapshotId: snapshotId,
    featureId,
    generatedAt,
    window: { durationHours },
    components,
  });
  writeJson(join(bundle, 'attribution.json'), {
    verdictId,
    evalSnapshotId: snapshotId,
    featureId,
    generatedAt,
    findings: [],
    noFindingRecord: { reason: 'fixture observation', evidence: 'fixture counts' },
  });
  writeJson(join(bundle, 'provenance.json'), {
    verdictId,
    generatedAt,
    rawInputs: [{ path: 'fixture-input.json', sha256: 'a'.repeat(64) }],
    generator: { name: 'independent-test-fixture', version: '1' },
    sanitizeRulesVersion: 'v1',
  });
  return bundle;
}

export function createEvalHubCorpus(t) {
  const root = createEvalHubRoot(t);
  writeEvalHubVerdict(root, {
    components: ['L1', 'C1', 'C2', 'route-serial'].map((id) => ({
      id,
      name: id === 'C1' ? 'hold_ball (MCP tool)' : `Fixture ${id}`,
      activationCounts: { observation_count: 7 },
      frictionCounts: { 'c1.zombie_hold_count': 0 },
      confidence: 'medium',
    })),
  });
  for (const [domainId, featureId] of [
    ['eval:memory', 'F200'],
    ['eval:sop', 'F192'],
    ['eval:capability-wakeup', 'F203'],
    ['eval:qc', 'F253'],
  ]) {
    writeEvalHubVerdict(root, {
      domainId,
      featureId,
      componentId: `fixture-${domainId.slice(5)}`,
      verdictId: `fixture-${domainId.slice(5)}-window`,
    });
  }
  return root;
}

export const fixtureCaseId = `eval-case-v1-${'d'.repeat(64)}`;
export const fixtureCaseVerdictIds = ['fixture-wakeup-fix-cycle', 'fixture-wakeup-observe-cycle'];

export function createEvalHubCase(t) {
  const root = createEvalHubRoot(t);
  for (const [index, verdictId] of fixtureCaseVerdictIds.entries()) {
    const generatedAt = `2026-08-0${1 + index * 7}T00:00:00.000Z`;
    const verdict = index === 0 ? 'fix' : 'keep_observe';
    const harnessUnderEval = { featureId: 'F203', componentId: 'fixture-navigation', name: 'Fixture navigation' };
    const bundle = writeEvalHubVerdict(root, {
      verdictId,
      domainId: 'eval:capability-wakeup',
      verdict,
      generatedAt,
      nextEvalAt: '2026-08-15T00:00:00.000Z',
      featureId: harnessUnderEval.featureId,
      componentId: harnessUnderEval.componentId,
      componentName: harnessUnderEval.name,
    });
    writeJson(join(bundle, 'lifecycle-root.json'), {
      schemaVersion: 2,
      caseId: fixtureCaseId,
      findingKey: 'fixture-navigation',
      verdictId,
      domainId: 'eval:capability-wakeup',
      createdAt: generatedAt,
      verdict,
      harnessUnderEval,
      ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus-47', requestedAction: 'fixture repair' },
      acceptanceReevalPlan: { nextEvalAt: '2026-08-15T00:00:00.000Z', closureCondition: 'fixture next sample' },
    });
  }
  return root;
}
