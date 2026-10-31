import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadDomains } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

const sidecarEntry = {
  label: 'Sidecar label',
  means: 'Sidecar explanation.',
  goodDirection: 'lower',
  category: 'friction',
  component: 'C1',
};

function writeA2aDomainWithMetricSidecar(domainsDir) {
  writeFileSync(
    join(domainsDir, 'eval-a2a.metrics.yaml'),
    `c1.hold_zombie_count:
  label: Sidecar label
  means: Sidecar explanation.
  goodDirection: lower
  category: friction
  component: C1
c2.verdict_without_pass_count:
  label: Sidecar-only label
  means: Count of verdicts that did not hand off the ball.
  goodDirection: lower
  category: friction
  component: C2
`,
  );

  writeFileSync(
    join(domainsDir, 'eval-a2a.yaml'),
    `domainId: eval:a2a
displayName: A2A Harness Eval
descriptionForHuman: Checks whether cat-to-cat handoff stays connected.
metricGlossaryRef: eval-a2a.metrics.yaml
metricGlossary:
  c1.hold_zombie_count:
    label: Inline label
    means: Inline explanation wins over sidecar defaults.
    goodDirection: lower
    category: friction
    component: C1
systemThreadId: thread_eval_a2a
evalCat:
  catId: codex
  handle: '@codex'
  model: gpt-5.5
frequency: daily
sourceAdapter: f167-runtime-eval
sourceRefsKind: a2a-snapshot-attribution
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F167
  ownerCatId: opus47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
`,
  );
}

describe('Eval Hub domain sidecar loading', () => {
  it('loads metricGlossaryRef sidecars without treating them as domains, with inline entries taking precedence', () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f248-eval-domain-sidecar-'));
    const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
    mkdirSync(domainsDir, { recursive: true });
    writeA2aDomainWithMetricSidecar(domainsDir);

    const domains = loadDomains(harnessFeedbackRoot);
    const a2a = domains.get('eval:a2a');
    assert.ok(a2a, 'eval:a2a should load even when a *.metrics.yaml sidecar exists');
    assert.equal(domains.size, 1, 'metric sidecar files must not be parsed as eval domains');
    assert.deepEqual(a2a.metricGlossary?.['c2.verdict_without_pass_count'], {
      ...sidecarEntry,
      label: 'Sidecar-only label',
      means: 'Count of verdicts that did not hand off the ball.',
      component: 'C2',
    });
    assert.equal(a2a.metricGlossary?.['c1.hold_zombie_count']?.label, 'Inline label');
    assert.equal(a2a.metricGlossary?.['c1.hold_zombie_count']?.means, 'Inline explanation wins over sidecar defaults.');
  });
});
