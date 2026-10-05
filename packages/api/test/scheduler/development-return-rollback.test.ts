import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveGrowingSourceMessageRevision } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { DevelopmentReturnService } from '../../src/infrastructure/scheduler/development-return/DevelopmentReturnService.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';
import { developmentReturnCurrentRevision as oldAuthority } from '../helpers/development-return-v46/DevelopmentReturnAuthority.js';
import { DevelopmentReturnService as OldService } from '../helpers/development-return-v46/DevelopmentReturnService.js';
import { DynamicTaskStore as OldStore } from '../helpers/development-return-v46/DynamicTaskStore.js';
import { reviewedExecution } from '../helpers/reviewed-development-return-fixture.js';

for (const phase of ['waiting', 'ready'] as const) {
  test(`v46 rollback preserves a ${phase} reviewed return through deadline/report and upgrade`, async (t) => {
    const f = await fixture(t);
    const execution = await reviewedExecution(f);
    const registered = await f.service.register(f.actor, execution.input, 'strict');
    const report = f.messages.append({
      userId: f.actor.userId,
      catId: f.actor.catId,
      threadId: execution.child.id,
      content: 'Implementation complete',
      mentions: [],
      timestamp: f.service.now() + 1,
    });
    const outcome = { sourceMessageId: report.id, outcome: 'completed' as const, evidenceRefs: ['artifact:result'] };
    if (phase === 'ready') {
      assert.ok(
        f.definitions.replacePrivateExecutionReturn(registered.registrationId, registered, {
          ...registered,
          status: 'ready',
          reason: 'terminal_report',
          report: { ...outcome, sourceMessageRevision: deriveGrowingSourceMessageRevision(report) },
        }),
      );
    }
    f.runner.stop();
    const before = f.service.read(registered.registrationId);
    const oldStore = new OldStore(f.db);
    const oldRunner = new TaskRunnerV2({
      ledger: new RunLedger(f.db),
      dynamicTaskStore: oldStore,
      logger: { info() {}, error() {} },
    });
    t.after(() => oldRunner.stop());
    const oldService = new OldService({ ...f.service.deps, definitions: oldStore, runner: oldRunner });
    assert.equal(await oldAuthority(oldService.deps, registered), null, 'old authority cannot handle this source');
    assert.equal(oldStore.getPrivateExecutionReturn(registered.registrationId), null);
    assert.equal(oldStore.getById(registered.registrationId)?.enabled, false);
    assert.equal(oldRunner.hydrateDynamic(oldStore, { get: () => oldService.template }), 0);
    f.tick(20000);
    const context = { signal: new AbortController().signal };
    await oldService.execute(registered.registrationId, context);
    await assert.rejects(
      oldService.report({ ...f.actor, threadId: execution.child.id }, registered.registrationId, outcome),
      /unavailable/,
    );
    assert.equal(f.wakes.length, 0);
    assert.deepEqual(
      f.service.read(registered.registrationId),
      before,
      'old execute/report cannot retire or consume it',
    );
    assert.throws(
      () => f.db.prepare('UPDATE dynamic_task_defs SET enabled = 1 WHERE id = ?').run(registered.registrationId),
      /CHECK/,
    );
    assert.throws(() => oldStore.remove(registered.registrationId), /typed owner transition/);
    const resumedStore = new DynamicTaskStore(f.db);
    const resumedRunner = new TaskRunnerV2({
      ledger: new RunLedger(f.db),
      dynamicTaskStore: resumedStore,
      logger: { info() {}, error() {} },
    });
    t.after(() => resumedRunner.stop());
    const resumed = new DevelopmentReturnService({
      ...f.service.deps,
      definitions: resumedStore,
      runner: resumedRunner,
    });
    assert.equal(resumedRunner.hydrateDynamic(resumedStore, { get: () => resumed.template }), 1);
    await resumedRunner.triggerNow(registered.registrationId);
    assert.equal(resumed.read(registered.registrationId)?.status, 'delivered');
    assert.equal(f.wakes.length, 1);
    assert.equal(f.tasks.get(f.input.taskId)?.entrustedWork?.closure.state, 'open');
  });
}

test('v46 still reads and delivers an active direct-human return after V47 migration', async (t) => {
  const f = await fixture(t);
  const state = await f.service.register(f.actor, f.input, 'strict');
  f.runner.stop();
  const oldStore = new OldStore(f.db);
  assert.deepEqual(oldStore.getPrivateExecutionReturn(state.registrationId), state);
  const oldService = new OldService({ ...f.service.deps, definitions: oldStore });
  f.tick(20000);
  await oldService.execute(state.registrationId, { signal: new AbortController().signal });
  assert.equal(oldStore.getPrivateExecutionReturn(state.registrationId)?.status, 'delivered');
  assert.equal(f.wakes.length, 1);
});
