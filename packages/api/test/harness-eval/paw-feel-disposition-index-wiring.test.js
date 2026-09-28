import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

describe('F278 API composition-root wiring', () => {
  it('owns exactly one Redis disposition ledger composition', () => {
    const constructors = source.match(/new RedisPawFeelDispositionEventLog\(/g) ?? [];
    assert.equal(constructors.length, 1);
    assert.match(source, /new PawFeelDispositionService\(\{\s*eventLog: pawFeelDispositionEventLog,/);
    assert.match(source, /new PawFeelDispositionReadModel\(\{/);
    assert.match(source, /eventLog: pawFeelDispositionEventLog/);
    assert.match(source, /messageStore/);
    assert.match(source, /coverageStore: pawFeelReconciliationCoverageStore/);
    assert.match(source, /await loadOrCreatePawFeelBundleSnapshotSigner\(redis\)/);
    assert.match(source, /bundleSnapshotSigner: pawFeelBundleSnapshotSigner/);
  });

  it('registers the shared read model and cat-signed writer on the HTTP surface', () => {
    assert.match(source, /app\.register\(pawFeelDispositionRoutes,\s*\{/);
    assert.match(source, /readModel: pawFeelDispositionReadModel/);
    assert.match(source, /dispositionService: pawFeelDispositionService/);
    assert.match(source, /dutyConfigStore: pawFeelDutyConfigStore/);
    assert.match(source, /callbackRegistry: registry/);
    assert.match(source, /agentKeyRegistry/);
  });

  it('registers reconciliation and duty before the unified scheduler starts', () => {
    const reconciliation = source.indexOf('createPawFeelReconciliationTaskSpec({');
    const duty = source.indexOf('createPawFeelDutyTaskSpec({');
    const start = source.indexOf('taskRunnerV2.start()');
    assert.ok(reconciliation >= 0, 'reconciliation task must be registered');
    assert.ok(duty >= 0, 'duty task must be registered');
    assert.ok(start > reconciliation && start > duty, 'F278 tasks must register before scheduler start');
    assert.match(source, /ensureEvalDomainThreads\(/);
    assert.match(source, /systemThreadId:\s*'thread_eval_friction'/);
    assert.match(source, /receiptReconciler:\s*pawFeelDutyReceiptService/);
  });

  it('binds typed intent and bounded standalone compatibility to the persisted source message', () => {
    assert.match(source, /new PawFeelCaptureIntentSidecar\(\{/);
    assert.match(source, /captureIntentSidecar: pawFeelCaptureIntentSidecar/);
    assert.match(source, /appendListener = \(message\) => \{/);
    assert.match(source, /captureAppendedPawFeelMessage\(\s*message,/);
    assert.doesNotMatch(source, /ingestPawFeelMessage\(message/);
  });

  it('composes continuing responsibility with exact F287 and task-workflow owner providers while legacy mutation stays gated', () => {
    assert.match(source, /new PawFeelDirectRepairSourceVerifier\(\{/);
    assert.match(source, /new PawFeelSourceCaseActionResolver\(\{/);
    assert.match(source, /new PawFeelContinuingResponsibilityResolver\(\{/);
    assert.match(source, /followUpResolver: pawFeelFollowUpResolver/);
    assert.doesNotMatch(source, /new PawFeelDirectRepairFederation\(\[\]\)/);
    assert.match(source, /new MemoryCuePawFeelDirectRepairOwnerProvider\(\{/);
    assert.match(source, /route:\s*memoryCuePawFeelDirectRepairRoute/);
    assert.match(source, /provider:\s*memoryCuePawFeelDirectRepairProvider/);
    assert.match(source, /new TaskWorkflowPawFeelDirectRepairOwnerProvider\(\{/);
    assert.match(source, /route:\s*taskWorkflowPawFeelDirectRepairRoute/);
    assert.match(source, /provider:\s*taskWorkflowPawFeelDirectRepairProvider/);
    assert.match(source, /directRepairResolver: pawFeelDirectRepairResolver/);
    assert.match(source, /repairOutcomeResolver: pawFeelDirectRepairOutcomeResolver/);
    assert.match(source, /new PawFeelBlockerReconciler\(/);
    assert.match(source, /blockerReconciler:\s*pawFeelBlockerReconciler/);
    assert.match(source, /new LegacyPawFeelBlockerCensusService\(\{/);
    assert.match(source, /app\.register\(pawFeelLegacyCensusRoutes,\s*\{/);
    assert.doesNotMatch(source, /executeLegacyPawFeelBlockerRecovery\(/);
  });
});
