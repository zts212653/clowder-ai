import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createEvalDomainDailySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';

const metricSidecarYaml = `
c1.hold_zombie_count:
  label: Zombie holds
  means: Holds that stayed open too long.
  goodDirection: lower
`;

const dailyDomainYaml = `
domainId: eval:test-daily-sidecar
displayName: Test Daily Sidecar Domain
systemThreadId: thread_test_daily_sidecar
evalCat:
  catId: gpt52
  handle: "@gpt52"
  model: gpt-5.4
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
`;

const ndayDomainYaml = dailyDomainYaml
  .replace('eval:test-daily-sidecar', 'eval:test-nday-sidecar')
  .replace('Test Daily Sidecar Domain', 'Test N-day Sidecar Domain')
  .replace('thread_test_daily_sidecar', 'thread_test_nday_sidecar')
  .replace('frequency: daily', 'frequency: every-3d');

function makeHarnessFeedbackRoot(domainYaml) {
  const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'eval-scheduler-sidecar-'));
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  writeFileSync(join(domainsDir, 'eval-test.metrics.yaml'), metricSidecarYaml);
  writeFileSync(join(domainsDir, 'eval-test.yaml'), domainYaml);
  return harnessFeedbackRoot;
}

describe('eval domain scheduler loaders — metric sidecars', () => {
  it('daily/weekly scheduler loader ignores *.metrics.yaml sidecars', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: makeHarnessFeedbackRoot(dailyDomainYaml) });

    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].subjectKey, 'eval:test-daily-sidecar');
  });

  it('N-day scheduler loader ignores *.metrics.yaml sidecars', async () => {
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: makeHarnessFeedbackRoot(ndayDomainYaml) });

    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].subjectKey, 'eval:test-nday-sidecar');
  });
});
