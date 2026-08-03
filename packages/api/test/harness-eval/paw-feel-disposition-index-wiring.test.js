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
  });

  it('binds typed intent and bounded standalone compatibility to the persisted source message', () => {
    assert.match(source, /new PawFeelCaptureIntentSidecar\(\{/);
    assert.match(source, /captureIntentSidecar: pawFeelCaptureIntentSidecar/);
    assert.match(source, /appendListener = \(message\) => \{/);
    assert.match(source, /captureAppendedPawFeelMessage\(\s*message,/);
    assert.doesNotMatch(source, /ingestPawFeelMessage\(message/);
  });
});
