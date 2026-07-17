import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createEvalDomainWeeklySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';
import { parseEvalDomainRegistryFile } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import { buildEvalCatInvocation } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';

const registryUrl = new URL(
  '../../../../docs/harness-feedback/eval-domains/eval-session-recovery.yaml',
  import.meta.url,
);
const harnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

async function loadDomain() {
  return parseEvalDomainRegistryFile(parse(await readFile(registryUrl, 'utf8')));
}

describe('eval:session-recovery domain activation', () => {
  it('loads the enabled docs-backed owner-scoped registry entry', async () => {
    const domain = await loadDomain();

    assert.equal(domain.domainId, 'eval:session-recovery');
    assert.equal(domain.systemThreadId, 'thread_eval_session_recovery');
    assert.deepEqual(domain.evalCat, {
      catId: 'cat-vjdun65e',
      handle: '@cat-vjdun65e',
      model: 'gpt-5.6-sol',
    });
    assert.equal(domain.frequency, 'weekly');
    assert.equal(domain.sourceAdapter, 'session-recovery-eval');
    assert.equal(domain.sourceRefsKind, 'session-recovery-window');
    assert.equal(domain.handoffTargetResolver.featureId, 'F192');
    assert.equal(domain.handoffTargetResolver.ownerCatId, 'cat-vjdun65e');
    assert.equal(domain.enabled, true);
  });

  it('teaches the eval cat the preview-assess-publish flow and domain boundary', async () => {
    const domain = await loadDomain();
    const invocation = buildEvalCatInvocation(
      {
        domain,
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'disabled' },
      },
      { wiredPublishDomains: new Set(['eval:session-recovery']) },
    );

    assert.match(invocation.instructions, /cat_cafe_preview_session_recovery_trials/);
    assert.match(invocation.instructions, /anchor/i);
    assert.match(invocation.instructions, /cat_cafe_publish_verdict/);
    assert.match(invocation.instructions, /session-recovery-window/);
    assert.match(invocation.instructions, /assessments/);
    assert.match(invocation.instructions, /stateReconstruction/);
    assert.match(invocation.instructions, /firstMeaningfulAction/);
    assert.match(invocation.instructions, /firstMeaningfulEventRef/);
    assert.match(invocation.instructions, /cat_cafe_read_session_recovery_evidence/);
    assert.match(invocation.instructions, /source_digest/);
    assert.match(invocation.instructions, /target_opening_invocation/);
    assert.match(invocation.instructions, /Truth priority/);
    assert.match(invocation.instructions, /Positive example/);
    assert.match(invocation.instructions, /Negative example/);
    assert.match(invocation.instructions, /affected field unknown|per-field unknown/);
    assert.match(invocation.instructions, /capability-wakeup/i);
    assert.match(invocation.instructions, /activation|whether.*woke/i);
    assert.match(invocation.instructions, /transition boundary|SessionBootstrap-driven|recovery correctness/i);
    assert.match(invocation.instructions, /owner scope|owner-scoped|authenticated principal/i);
  });

  it('keeps publish instructions fail-closed when runtime wiring is absent', async () => {
    const domain = await loadDomain();
    const invocation = buildEvalCatInvocation(
      {
        domain,
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'disabled' },
      },
      { wiredPublishDomains: new Set(['eval:a2a']) },
    );

    assert.match(invocation.instructions, /cat_cafe_preview_session_recovery_trials/);
    assert.doesNotMatch(invocation.instructions, /cat_cafe_publish_verdict/);
  });

  it('is picked up by the weekly scheduler after activation', async () => {
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot });
    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    assert.ok(result.workItems.some((item) => item.subjectKey === 'eval:session-recovery'));
  });

  it('keeps generator, wired publish set, and prereq probe aligned in bootstrap', async () => {
    const indexSource = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');

    assert.match(indexSource, /verdictGenerators\['eval:session-recovery'\]/);
    assert.match(indexSource, /wiredPublishDomains\.add\('eval:session-recovery'\)/);
    assert.match(
      indexSource,
      /domainId === 'eval:session-recovery'[\s\S]*isSessionRecoverySourceRefs/,
      'scheduled activation must fail closed when the session-recovery selector validator is absent',
    );
  });
});
