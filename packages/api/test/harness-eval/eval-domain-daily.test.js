import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createEvalDomainDailySpec,
  createEvalDomainWeeklySpec,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';

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

  it('gate returns workItems for daily-frequency domains only', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    // Daily domains: eval:a2a + eval:memory + eval:task-outcome (eval:sop + eval:capability-wakeup are weekly)
    assert.equal(result.workItems.length, 3, `expected exactly 3 daily domains, got ${result.workItems.length}`);

    const a2a = result.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2a, 'should have eval:a2a work item');
    assert.equal(a2a.signal.domainId, 'eval:a2a');

    const memory = result.workItems.find((w) => w.subjectKey === 'eval:memory');
    assert.ok(memory, 'should have eval:memory work item');
    assert.equal(memory.signal.domainId, 'eval:memory');

    const taskOutcome = result.workItems.find((w) => w.subjectKey === 'eval:task-outcome');
    assert.ok(taskOutcome, 'should have eval:task-outcome work item');
    assert.equal(taskOutcome.signal.domainId, 'eval:task-outcome');
  });

  it('gate skips domains whose legacy tasks are still active (P1-2)', async () => {
    // Simulate: memory-recall-digest is still active for eval:memory
    // (eval:a2a legacyScheduledTaskIds was cleaned to [] on 2026-06-01)
    const activeLegacyTasks = [{ id: 'memory-recall-digest', templateId: 'memory-recall-digest', enabled: true }];
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      listDynamicTasks: () => activeLegacyTasks,
    });

    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'should still run for domains without active legacy');
    // eval:memory should be skipped (memory-recall-digest is active)
    const memory = result.workItems.find((w) => w.subjectKey === 'eval:memory');
    assert.equal(memory, undefined, 'eval:memory must be skipped when its legacy task is active');
    // eval:a2a and eval:task-outcome should remain (legacyScheduledTaskIds = [])
    const a2a = result.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2a, 'eval:a2a should still be included (no legacy tasks)');
    const taskOutcome = result.workItems.find((w) => w.subjectKey === 'eval:task-outcome');
    assert.ok(taskOutcome, 'eval:task-outcome should still be included (no legacy tasks)');
  });

  it('gate still runs when only one daily domain has active legacy tasks', async () => {
    // With frequency filtering, daily gate only sees daily domains (a2a, memory, task-outcome).
    // eval:a2a has legacyScheduledTaskIds=[] (cleaned), so we simulate a hypothetical
    // legacy task for a2a + the real memory-recall-digest for memory.
    // Since a2a/task-outcome have NO legacy tasks, even with memory blocked, gate still runs.
    // To truly block all daily domains, every domain would need legacy tasks — but not all do.
    // Updated: test now verifies that with only memory blocked, gate still runs.
    const activeLegacyTasks = [{ id: 'memory-recall-digest', templateId: 'memory-recall-digest', enabled: true }];
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      listDynamicTasks: () => activeLegacyTasks,
    });

    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'gate still runs because eval:a2a has no legacy tasks');
    const a2a = result.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2a, 'eval:a2a is included (legacyScheduledTaskIds=[])');
    const taskOutcome = result.workItems.find((w) => w.subjectKey === 'eval:task-outcome');
    assert.ok(taskOutcome, 'eval:task-outcome is included (legacyScheduledTaskIds=[])');
  });

  it('gate returns run=false when no eval domains exist', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: '/nonexistent/path' });

    const result = await spec.admission.gate();

    assert.equal(result.run, false);
    assert.equal(result.reason, 'no registered eval domains');
  });

  it('execute delivers message to system thread and triggers eval cat as the thread owner (#796)', async () => {
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
    });

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
    assert.equal(triggerArgs[2], 'default-user'); // owner userId, so stream replies are visible after refresh
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

  it('daily gate excludes weekly-frequency domains (eval:sop)', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const result = await spec.admission.gate();
    assert.equal(result.run, true);

    const domainIds = result.workItems.map((w) => w.subjectKey);
    assert.ok(!domainIds.includes('eval:sop'), 'eval:sop (weekly) must NOT appear in daily gate');
    assert.ok(domainIds.includes('eval:a2a'), 'eval:a2a (daily) must appear');
    assert.ok(domainIds.includes('eval:memory'), 'eval:memory (daily) must appear');
    assert.ok(domainIds.includes('eval:task-outcome'), 'eval:task-outcome (daily) must appear');
  });
});

describe('KD-17 snapshot-first error paths (eval:harness-ledger)', () => {
  // Fake domain signal matching eval:harness-ledger config.
  const harnessLedgerDomain = {
    domainId: 'eval:harness-ledger',
    displayName: 'Harness Ledger Eval',
    systemThreadId: 'thread_eval_harness_ledger',
    evalCat: { catId: 'gpt52', handle: '@gpt52', model: 'gpt-5.4' },
    frequency: 'weekly',
    sourceAdapter: 'f257-prompt-segments',
    sourceRefsKind: 'prompt-segments',
    threadPolicy: {
      role: 'working-home',
      stateSot: 'registry',
      allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
    },
    legacyScheduledTaskIds: [],
    handoffTargetResolver: { featureId: 'F257', ownerCatId: 'opus-47', threadLookup: 'feature-thread' },
    sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
    enabled: true, // pretend enabled for testing execute path
  };

  it('scheduled: skips invocation when guardRejectionLog provider is absent', async () => {
    // No guardRejectionLog in config → deliver SKIPPED message + return (no cat invoke).
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const deliverMock = mock.fn(async () => 'msg_skip');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(harnessLedgerDomain, 'eval:harness-ledger', ctx);

    // deliver was called once with SKIPPED message (not eval invocation)
    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(
      content.includes('SKIPPED (harness ledger snapshot unavailable)'),
      `should contain SKIPPED header, got: ${content.slice(0, 100)}`,
    );
    assert.ok(
      content.includes('provider_not_wired') || content.includes('not wired'),
      'should mention provider not wired',
    );
    assert.equal(deliverMock.mock.calls[0].arguments[0].threadId, 'thread_eval_harness_ledger');

    // invokeTrigger must NOT be called (no cat invocation)
    assert.equal(triggerMock.mock.callCount(), 0, 'eval cat must NOT be invoked without snapshot');
  });

  it('scheduled: skips invocation when snapshot production throws (Redis error)', async () => {
    // guardRejectionLog exists but queryWindowStrict throws → deliver SKIPPED message + return.
    const throwingLog = {
      queryWindowStrict: async () => {
        throw new Error('READONLY: Redis failover in progress');
      },
      queryWindowStrictComplete: async () => {
        throw new Error('READONLY: Redis failover in progress');
      },
      queryWindow: async () => [],
    };

    const spec = createEvalDomainWeeklySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      guardRejectionLog: throwingLog,
    });

    const deliverMock = mock.fn(async () => 'msg_skip_err');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(harnessLedgerDomain, 'eval:harness-ledger', ctx);

    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(content.includes('SKIPPED (harness ledger snapshot unavailable)'), 'should contain SKIPPED header');
    assert.ok(content.includes('Redis failover'), 'should contain error detail');

    assert.equal(triggerMock.mock.callCount(), 0, 'eval cat must NOT be invoked on snapshot error');
  });

  it('scheduled: delivers invocation with evidence when snapshot succeeds', async () => {
    // guardRejectionLog produces data → eval cat invoked with precomputedEvidence.
    // Use a temp dir so snapshot files don't pollute the repo.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'kd17-success-'));
    const successLog = {
      queryWindowStrict: async () => [
        { eventId: 'e1', kind: 'hold_ball_429', guardId: 'guard-1', timestamp: Date.now(), rawPayload: {} },
      ],
      queryWindowStrictComplete: async () => ({
        events: [{ eventId: 'e1', kind: 'hold_ball_429', guardId: 'guard-1', timestamp: Date.now(), rawPayload: {} }],
        truncated: false,
      }),
      queryWindow: async () => [],
    };

    const spec = createEvalDomainWeeklySpec({
      harnessFeedbackRoot: tmpRoot,
      guardRejectionLog: successLog,
    });

    const deliverMock = mock.fn(async () => 'msg_success');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(harnessLedgerDomain, 'eval:harness-ledger', ctx);

    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    // Must NOT contain SKIPPED
    assert.ok(!content.includes('SKIPPED'), 'successful path should not contain SKIPPED');
    // Must contain evidence (snapshot summary)
    assert.ok(content.includes('Pre-computed Guard Rejection Snapshot'), 'should contain pre-computed evidence');
    assert.ok(content.includes('evalRunId'), 'should contain evalRunId reference');

    // KD-17 last-hop: delivered content must include exact sourceRefs JSON
    // with windowStartMs, windowEndMs, and evalRunId as copyable values.
    // Eval cat copies this block verbatim — no ISO→epoch conversion needed.
    assert.ok(content.includes('"windowStartMs"'), 'should contain exact windowStartMs field');
    assert.ok(content.includes('"windowEndMs"'), 'should contain exact windowEndMs field');
    assert.ok(content.includes('"kind": "prompt-segments"'), 'should contain kind in sourceRefs JSON');

    // Extract the sourceRefs JSON from the fenced code block and verify
    // it would pass the generator's exact-window check against the stored snapshot.
    const allJsonBlocks = [...content.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)];
    const sourceRefsBlock = allJsonBlocks.find((m) => m[1].includes('"prompt-segments"'));
    assert.ok(sourceRefsBlock, 'should have a fenced JSON block with sourceRefs');
    const sourceRefs = JSON.parse(sourceRefsBlock[1]);
    assert.equal(sourceRefs.kind, 'prompt-segments');
    assert.equal(typeof sourceRefs.windowStartMs, 'number', 'windowStartMs must be a number');
    assert.equal(typeof sourceRefs.windowEndMs, 'number', 'windowEndMs must be a number');
    assert.ok(sourceRefs.windowEndMs > sourceRefs.windowStartMs, 'window must be valid');
    assert.ok(/^hlr-\d+-[a-f0-9]{8}$/.test(sourceRefs.evalRunId), 'evalRunId must match safe format');

    // invokeTrigger must be called (cat invoked)
    assert.equal(triggerMock.mock.callCount(), 1, 'eval cat must be invoked with evidence');

    // Cleanup temp snapshot files
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe('F257 sub-item 1: zero events → skip invocation (eval:harness-ledger)', () => {
  const harnessLedgerDomain = {
    domainId: 'eval:harness-ledger',
    displayName: 'Harness Ledger Eval',
    systemThreadId: 'thread_eval_harness_ledger',
    evalCat: { catId: 'gpt52', handle: '@gpt52', model: 'gpt-5.4' },
    frequency: 'weekly',
    sourceAdapter: 'f257-prompt-segments',
    sourceRefsKind: 'prompt-segments',
    threadPolicy: {
      role: 'working-home',
      stateSot: 'registry',
      allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
    },
    legacyScheduledTaskIds: [],
    handoffTargetResolver: { featureId: 'F257', ownerCatId: 'opus-47', threadLookup: 'feature-thread' },
    sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
    enabled: true,
  };

  it('scheduled: skips invocation when snapshot has zero events (LLM cost = 0)', async () => {
    // guardRejectionLog returns empty array → totalEvents = 0 → skip.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'kd17-zero-'));
    const emptyLog = {
      queryWindowStrict: async () => [],
      queryWindowStrictComplete: async () => ({ events: [], truncated: false }),
      queryWindow: async () => [],
    };

    const spec = createEvalDomainWeeklySpec({
      harnessFeedbackRoot: tmpRoot,
      guardRejectionLog: emptyLog,
    });

    const deliverMock = mock.fn(async () => 'msg_zero');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(harnessLedgerDomain, 'eval:harness-ledger', ctx);

    // deliver was called once with SKIPPED (zero events) message
    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(
      content.includes('SKIPPED (zero events in window)'),
      `should contain zero-events SKIPPED header, got: ${content.slice(0, 120)}`,
    );
    assert.ok(content.includes('evalRunId'), 'should mention evalRunId for audit trail');
    assert.ok(content.includes('LLM cost = 0'), 'should mention cost savings');
    assert.equal(deliverMock.mock.calls[0].arguments[0].threadId, 'thread_eval_harness_ledger');

    // invokeTrigger must NOT be called (no cat invocation — nothing to evaluate)
    assert.equal(triggerMock.mock.callCount(), 0, 'eval cat must NOT be invoked on zero events');

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('scheduled: zero-event skip still writes snapshot file (audit trail)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'kd17-zero-snap-'));
    const emptyLog = {
      queryWindowStrict: async () => [],
      queryWindowStrictComplete: async () => ({ events: [], truncated: false }),
      queryWindow: async () => [],
    };

    const spec = createEvalDomainWeeklySpec({
      harnessFeedbackRoot: tmpRoot,
      guardRejectionLog: emptyLog,
    });

    const deliverMock = mock.fn(async () => 'msg_zero_snap');
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: mock.fn() },
    };

    await spec.run.execute(harnessLedgerDomain, 'eval:harness-ledger', ctx);

    // Snapshot should still exist on disk (audit trail even for empty windows)
    const { readdirSync, readFileSync } = await import('node:fs');
    const snapshotsDir = join(tmpRoot, 'run-snapshots');
    const files = readdirSync(snapshotsDir);
    assert.equal(files.length, 1, 'exactly one snapshot file should exist');
    const snapshot = JSON.parse(readFileSync(join(snapshotsDir, files[0]), 'utf8'));
    assert.equal(snapshot.totalEvents, 0, 'snapshot should record zero events');
    assert.ok(/^hlr-\d+-[a-f0-9]{8}$/.test(snapshot.evalRunId), 'evalRunId format');

    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe('eval-domain-weekly task spec (AC-E19, AC-E20)', () => {
  it('returns a valid TaskSpec_P1 with weekly cron and correct id', () => {
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    assert.equal(spec.id, 'eval-domain-weekly');
    assert.equal(spec.profile, 'awareness');
    assert.deepEqual(spec.trigger, { type: 'cron', expression: '0 3 * * 0', timezone: 'UTC' });
    assert.equal(spec.run.overlap, 'skip');
    assert.equal(spec.run.timeoutMs, 60_000);
    assert.deepEqual(spec.state, { runLedger: 'sqlite' });
    assert.deepEqual(spec.outcome, { whenNoSignal: 'drop' });
    assert.equal(spec.enabled(), true);
    assert.equal(spec.display.label, '每周 Harness Eval');
    assert.equal(spec.display.category, 'system');
  });

  it('weekly gate includes enabled weekly domains (capability-wakeup + sop + harness-ledger), excludes daily', async () => {
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const result = await spec.admission.gate();
    assert.equal(result.run, true);

    const domainIds = result.workItems.map((w) => w.subjectKey);
    assert.ok(
      domainIds.includes('eval:capability-wakeup'),
      'eval:capability-wakeup (weekly + enabled) must appear in weekly gate',
    );
    // Re-enabled 2026-06-10 by feat/f192-sop-wiring: all 3 wiring conditions met.
    assert.ok(domainIds.includes('eval:sop'), 'eval:sop (re-enabled) must appear in weekly gate');
    // KD-17 snapshot-first: eval:harness-ledger re-enabled after data access resolved.
    assert.ok(
      domainIds.includes('eval:harness-ledger'),
      'eval:harness-ledger (weekly + re-enabled after KD-17) must appear in weekly gate',
    );
    assert.ok(!domainIds.includes('eval:a2a'), 'eval:a2a (daily) must NOT appear in weekly gate');
    assert.ok(!domainIds.includes('eval:memory'), 'eval:memory (daily) must NOT appear in weekly gate');
    assert.ok(!domainIds.includes('eval:task-outcome'), 'eval:task-outcome (daily) must NOT appear in weekly gate');
  });

  it('weekly gate includes re-enabled eval:sop (was sunset, now wired)', async () => {
    // eval:sop was sunset 2026-06-06 (enabled: false) due to missing generator wiring.
    // Re-enabled 2026-06-10 by feat/f192-sop-wiring: SopTrace producer + file-writer +
    // PUBLISH_VERDICT_INSTRUCTIONS all wired. The enabled flag removal means weekly cron
    // now picks up eval:sop alongside eval:capability-wakeup.
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });
    const result = await spec.admission.gate();

    assert.ok(result.run, 'weekly gate should run with re-enabled eval:sop');
    const domainIds = result.workItems.map((w) => w.subjectKey);
    assert.ok(
      domainIds.includes('eval:sop'),
      `re-enabled eval:sop must appear in weekly gate, got: ${JSON.stringify(domainIds)}`,
    );
  });

  it('weekly gate returns run=false when no weekly domains exist', async () => {
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot: '/nonexistent/path' });

    const result = await spec.admission.gate();

    assert.equal(result.run, false);
  });

  it('weekly execute delivers message with "Weekly eval" trigger reason', async () => {
    // Post-sunset (2026-06-06): eval:sop is no longer the test subject for
    // weekly cron execute because it's `enabled: false`. eval:capability-wakeup
    // is the remaining enabled weekly domain — switch to it.
    const spec = createEvalDomainWeeklySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true);
    const cwItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:capability-wakeup');
    assert.ok(cwItem, 'eval:capability-wakeup should be present (weekly + enabled)');

    const deliverMock = mock.fn(async () => 'msg_weekly_001');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(cwItem.signal, cwItem.subjectKey, ctx);

    assert.equal(deliverMock.mock.callCount(), 1);
    const deliverCall = deliverMock.mock.calls[0].arguments[0];
    assert.equal(deliverCall.threadId, 'thread_eval_capability_wakeup');
    assert.equal(deliverCall.userId, 'scheduler');
    assert.ok(deliverCall.content.includes('eval:capability-wakeup'), 'content should mention domain');

    assert.equal(triggerMock.mock.callCount(), 1);
    const triggerArgs = triggerMock.mock.calls[0].arguments;
    assert.equal(triggerArgs[0], 'thread_eval_capability_wakeup');
    assert.ok(triggerArgs[3].includes('Weekly eval'), 'trigger reason should say Weekly');
  });
});
