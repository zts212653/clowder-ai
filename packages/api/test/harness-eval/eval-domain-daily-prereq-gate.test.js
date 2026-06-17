import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEvalDomainDailySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

/**
 * Direction B (clowder-ai#923 fix): publish-prereq gate
 *
 * Bug class: when the scheduled eval cron lands on a runtime whose publish-verdict
 * machinery is missing prerequisites (e.g. dogfood worktree on a stale branch lacking
 * the sourceRefs validator), the eval cat receives full publish+cross-post instructions,
 * hits an infra blocker at publish time, and (per its prompt) cross-posts the blocker
 * into an unrelated feature thread. The gate prevents cat invocation entirely when the
 * probe reports missing prereqs — no LLM = no cross-post leak.
 *
 * Split out of eval-domain-daily.test.js to keep both files under the 350-line cap
 * (砚砚 R1 P1#2 on PR #2297).
 */
describe('eval-domain-daily — Direction B publish-prereq gate (clowder-ai#923)', () => {
  it('probe omitted → backward compat (cat invoked as before)', async () => {
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
      // publishPrereqProbe intentionally omitted
    });

    const gateResult = await spec.admission.gate();
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_compat');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    // Without probe: trigger fires + deliver fires normal invocation message
    assert.equal(triggerMock.mock.callCount(), 1, 'trigger must fire when no probe is configured');
    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(!content.includes('SKIPPED'), 'normal invocation message must not be the SKIPPED variant');
  });

  it('probe returns false → skip + blocked message + no trigger', async () => {
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
      publishPrereqProbe: () => false,
    });

    const gateResult = await spec.admission.gate();
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_skip');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    // SKIPPED path: deliver fires once with blocked message; trigger does NOT fire (no LLM call).
    assert.equal(triggerMock.mock.callCount(), 0, 'trigger must NOT fire when prereq is missing');
    assert.equal(deliverMock.mock.callCount(), 1);
    const call = deliverMock.mock.calls[0].arguments[0];
    assert.equal(call.threadId, 'thread_eval_a2a', 'blocked message must stay in system thread');
    assert.equal(call.userId, 'scheduler');
    assert.ok(call.content.includes('SKIPPED'), 'message must announce SKIPPED');
    assert.ok(
      call.content.includes('publish prereq missing'),
      'message must use stable header so dedup/grep can find it',
    );
    assert.ok(
      call.content.includes('validation.js'),
      'message must point operators at validation.js (where isA2aSourceRefs lives) — see R1 fix',
    );
  });

  it('probe returns true → proceed (cat invoked as normal)', async () => {
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
      publishPrereqProbe: () => true,
    });

    const gateResult = await spec.admission.gate();
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_ok');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    assert.equal(triggerMock.mock.callCount(), 1, 'trigger fires when probe says prereqs are met');
    assert.equal(deliverMock.mock.callCount(), 1);
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(!content.includes('SKIPPED'), 'happy-path message must not be SKIPPED variant');
  });

  it('probe throws → fail-closed (skip, no LLM call, no leak)', async () => {
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
      publishPrereqProbe: () => {
        throw new Error('synthetic probe failure');
      },
    });

    const gateResult = await spec.admission.gate();
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_fail');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    // Probe throwing must not propagate out of execute() — fail-closed = skip, not crash.
    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    assert.equal(triggerMock.mock.callCount(), 0, 'fail-closed: trigger never fires when probe throws');
    assert.equal(deliverMock.mock.callCount(), 1, 'fail-closed: SKIPPED message still posted to system thread');
    const content = deliverMock.mock.calls[0].arguments[0].content;
    assert.ok(content.includes('SKIPPED'), 'fail-closed path uses the SKIPPED message');
  });

  it('probe returns Promise<boolean> → async API supported', async () => {
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
      publishPrereqProbe: async () => false,
    });

    const gateResult = await spec.admission.gate();
    const a2aItem = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
    assert.ok(a2aItem);

    const deliverMock = mock.fn(async () => 'msg_async');
    const triggerMock = mock.fn();
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: triggerMock },
    };

    await spec.run.execute(a2aItem.signal, a2aItem.subjectKey, ctx);

    assert.equal(triggerMock.mock.callCount(), 0, 'async false → trigger must still be skipped');
    assert.equal(deliverMock.mock.callCount(), 1);
    assert.ok(deliverMock.mock.calls[0].arguments[0].content.includes('SKIPPED'));
  });

  it('all-domains-skip invariant: blocked message threadId never leaks to feature thread', async () => {
    // Run execute() against every daily domain when probe returns false. For each one
    // the SKIPPED message must land on the domain's OWN systemThreadId, never on a
    // feature thread. This is the exact failure mode clowder-ai#923 was about:
    // the eval cat was cross_post_message-ing infra blockers into F-thread space.
    const spec = createEvalDomainDailySpec({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      defaultUserId: 'default-user',
      publishPrereqProbe: () => false,
    });

    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true);
    assert.ok(gateResult.workItems.length >= 1);

    for (const item of gateResult.workItems) {
      const deliverMock = mock.fn(async () => `msg_${item.subjectKey}`);
      const triggerMock = mock.fn();
      const ctx = {
        assignedCatId: null,
        deliver: deliverMock,
        invokeTrigger: { trigger: triggerMock },
      };

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 0, `${item.subjectKey}: trigger must not fire`);
      assert.equal(deliverMock.mock.callCount(), 1, `${item.subjectKey}: exactly one deliver call`);
      const deliverArg = deliverMock.mock.calls[0].arguments[0];
      assert.equal(
        deliverArg.threadId,
        item.signal.systemThreadId,
        `${item.subjectKey}: blocked message must go to the domain's systemThreadId (got ${deliverArg.threadId})`,
      );
      assert.ok(
        deliverArg.threadId.startsWith('thread_eval_'),
        `${item.subjectKey}: threadId must be an eval system thread, not a feature thread`,
      );
    }
  });
});
