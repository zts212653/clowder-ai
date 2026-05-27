import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEvalDomainDailySpec } from '../../dist/infrastructure/harness-eval/eval-domain-daily.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

describe('eval-domain-daily task spec', () => {
  it('returns a valid TaskSpec_P1 with expected id, trigger, and display', () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    assert.equal(spec.id, 'eval-domain-daily');
    assert.equal(spec.profile, 'awareness');
    assert.deepEqual(spec.trigger, { type: 'cron', expression: '0 3 * * *', timezone: 'UTC' });
    assert.equal(spec.run.overlap, 'skip');
    assert.equal(spec.run.timeoutMs, 60_000);
    assert.deepEqual(spec.state, { runLedger: 'sqlite' });
    assert.deepEqual(spec.outcome, { whenNoSignal: 'drop' });
    assert.equal(spec.enabled(), true);
    assert.equal(spec.display.label, '每日 Harness Eval');
    assert.equal(spec.display.category, 'system');
  });

  it('gate returns workItems for each registered eval domain', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    assert.ok(result.workItems.length >= 2, `expected ≥2 domains, got ${result.workItems.length}`);

    const a2a = result.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2a, 'should have eval:a2a work item');
    assert.equal(a2a.signal.domainId, 'eval:a2a');

    const memory = result.workItems.find((w) => w.subjectKey === 'eval:memory');
    assert.ok(memory, 'should have eval:memory work item');
    assert.equal(memory.signal.domainId, 'eval:memory');
  });

  it('gate skips domains whose legacy tasks are still active (P1-2)', async () => {
    // Simulate: harness-fit-digest is still active for eval:a2a
    const activeLegacyTasks = [{ id: 'harness-fit-digest', templateId: 'harness-fit-digest', enabled: true }];
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      listDynamicTasks: () => activeLegacyTasks,
    });

    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'should still run for domains without active legacy');
    // eval:a2a should be skipped (harness-fit-digest is active)
    const a2a = result.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.equal(a2a, undefined, 'eval:a2a must be skipped when its legacy task is active');
    // eval:memory should remain (memory-recall-digest is NOT in the active list)
    const memory = result.workItems.find((w) => w.subjectKey === 'eval:memory');
    assert.ok(memory, 'eval:memory should still be included');
  });

  it('gate returns run=false when all domains have active legacy tasks (P1-2)', async () => {
    const activeLegacyTasks = [
      { id: 'harness-fit-digest', templateId: 'harness-fit-digest', enabled: true },
      { id: 'memory-recall-digest', templateId: 'memory-recall-digest', enabled: true },
    ];
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      listDynamicTasks: () => activeLegacyTasks,
    });

    const result = await spec.admission.gate();

    assert.equal(result.run, false, 'no domains should run when all have active legacy');
    assert.ok(result.reason.includes('legacy'), 'reason should mention legacy tasks');
  });

  it('gate returns run=false when no eval domains exist', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: '/nonexistent/path' });

    const result = await spec.admission.gate();

    assert.equal(result.run, false);
    assert.equal(result.reason, 'no registered eval domains');
  });

  it('execute delivers message to system thread and triggers eval cat', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    // Get a real domain signal from gate
    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true);
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_123');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    // deliver was called once with the correct threadId
    assert.equal(deliverMock.mock.callCount(), 1);
    const deliverCall = deliverMock.mock.calls[0].arguments[0];
    assert.equal(deliverCall.threadId, 'thread_eval_a2a');
    assert.equal(deliverCall.userId, 'scheduler');
    assert.ok(deliverCall.content.includes('eval:a2a'), 'content should mention domain');
    // P1-2: legacyCleanup status must be accurate, not hardcoded 'not_checked'
    assert.ok(
      deliverCall.content.includes('"status": "disabled"'),
      'legacyCleanup.status should be "disabled" (no active legacy tasks), not "not_checked"',
    );

    // invokeTrigger was called with eval cat
    assert.equal(triggerMock.mock.callCount(), 1);
    const triggerArgs = triggerMock.mock.calls[0].arguments;
    assert.equal(triggerArgs[0], 'thread_eval_a2a'); // threadId
    assert.ok(triggerArgs[1], 'should have catId'); // catId
    assert.equal(triggerArgs[2], 'scheduler'); // userId
    assert.ok(triggerArgs[3].includes('eval:a2a'), 'reason should mention domain');
    assert.equal(triggerArgs[4], 'msg_123'); // messageId
  });

  it('execute reports "disabled" when legacy task exists but is disabled (P2 regression)', async () => {
    // DynamicTaskStore.getAll() returns disabled defs too — execute must not
    // misreport them as 'dry_run_ready' when they're already disabled.
    const disabledLegacy = [{ id: 'harness-fit-digest', templateId: 'harness-fit-digest', enabled: false }];
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      listDynamicTasks: () => disabledLegacy,
    });

    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true);
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem, 'eval:a2a should pass gate (legacy is disabled, not active)');

    const deliverMock = mock.fn(async () => 'msg_789');
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: mock.fn() },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(
      content.includes('"status": "disabled"'),
      `legacyCleanup.status must be "disabled" when legacy task is disabled, got: ${content.match(/"status":\s*"[^"]+"/)?.[0]}`,
    );
  });

  it('execute ensures system thread exists before delivering (P1-1)', async () => {
    const ensureThreadMock = mock.fn(async () => {});
    const updateSystemKindMock = mock.fn(async () => {});
    const getMock = mock.fn(async () => null); // thread doesn't exist yet

    const threadStore = {
      ensureThread: ensureThreadMock,
      updateSystemKind: updateSystemKindMock,
      get: getMock,
    };

    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      threadStore,
    });

    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true);
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_456');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    // Thread ensure must be called BEFORE deliver
    assert.equal(ensureThreadMock.mock.callCount(), 1, 'ensureThread must be called once for the domain thread');
    const ensureArgs = ensureThreadMock.mock.calls[0].arguments;
    assert.equal(ensureArgs[0], 'thread_eval_a2a', 'must ensure the correct thread ID');

    // systemKind must be set
    assert.equal(updateSystemKindMock.mock.callCount(), 1, 'updateSystemKind must be called for eval_domain');

    // deliver still called
    assert.equal(deliverMock.mock.callCount(), 1);
  });

  it('execute is a no-op when ctx.deliver is not provided', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true);
    const item = gateResult.workItems[0];

    // No deliver = scheduler hasn't wired up message delivery — execute should not throw
    const ctx = { assignedCatId: null };
    await spec.run.execute(item.signal, item.subjectKey, ctx);
    // If we get here without throwing, test passes
  });
});
