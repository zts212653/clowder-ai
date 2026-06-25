/**
 * F245 PR2 — N-day cadence execute tests (Redis last-dispatch update).
 *
 * Split from eval-domain-nday.test.js (cloud R4 P1: file-size hard limit 350 lines).
 * Gate tests remain in eval-domain-nday.test.js.
 * Shared fixtures/helpers in eval-domain-nday-fixtures.js.
 *
 * Tests createEvalDomainNDaySpec execute():
 *  - Successful deliver → Redis last-dispatch key written
 *  - No ctx.deliver → Redis NOT written
 *  - invokeTrigger throws → Redis NOT written (gpt52 R1 P1)
 *  - invokeTrigger returns 'full' → Redis NOT written (cloud R3 P1)
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';
import { FIXTURE_FRICTION_3D_YAML, makeRedis, makeTempRoot } from './eval-domain-nday-fixtures.js';

// ---- Execute tests ----

describe('createEvalDomainNDaySpec — execute (Redis last-dispatch update)', () => {
  // Use eval:friction (a domain with registered instructions in buildEvalCatInvocation)
  // because buildEvalCatInvocation is fail-closed for unknown domainIds. The fixture
  // is still hermetic (temp dir), it just uses the real eval:friction domainId.
  it('execute updates Redis last-dispatch key after successful deliver', async () => {
    const root = makeTempRoot(FIXTURE_FRICTION_3D_YAML);
    const redis = makeRedis();
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });

    const gateResult = await spec.admission.gate();
    assert.equal(gateResult.run, true, 'gate must run to get domain signal');
    const item = gateResult.workItems.find((w) => w.subjectKey === 'eval:friction');
    assert.ok(item, 'eval:friction must be in workItems');

    const deliverMock = mock.fn(async () => 'msg_nday_001');
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: { trigger: mock.fn() },
    };

    const beforeMs = Date.now();
    await spec.run.execute(item.signal, item.subjectKey, ctx);
    const afterMs = Date.now();

    assert.equal(deliverMock.mock.calls.length, 1, 'deliver must be called exactly once');
    const storedVal = redis._store.get('eval-nday-last-dispatch:eval:friction');
    assert.ok(storedVal, 'Redis last-dispatch key must be set after execute');
    const storedMs = parseInt(storedVal, 10);
    assert.ok(
      storedMs >= beforeMs && storedMs <= afterMs,
      `stored timestamp ${storedMs} must be within [${beforeMs}, ${afterMs}]`,
    );
  });

  it('execute does NOT update Redis when deliver is not called (no ctx.deliver)', async () => {
    const root = makeTempRoot(FIXTURE_FRICTION_3D_YAML);
    const redis = makeRedis();
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });

    const gateResult = await spec.admission.gate();
    const item = gateResult.workItems.find((w) => w.subjectKey === 'eval:friction');
    assert.ok(item);

    // No deliver → execute should handle gracefully, no Redis update
    const ctx = { assignedCatId: null };
    await spec.run.execute(item.signal, item.subjectKey, ctx);

    const storedVal = redis._store.get('eval-nday-last-dispatch:eval:friction');
    assert.equal(storedVal, undefined, 'Redis must NOT be written when deliver was not called');
  });

  it('execute does NOT update Redis when invokeTrigger throws (gpt52 R1 P1)', async () => {
    // gpt52 R1 P1: trigger failure must NOT trip the N-day gate.
    // If trigger throws, eval cat was never notified — domain must be retried on next probe.
    const root = makeTempRoot(FIXTURE_FRICTION_3D_YAML);
    const redis = makeRedis();
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });

    const gateResult = await spec.admission.gate();
    const item = gateResult.workItems.find((w) => w.subjectKey === 'eval:friction');
    assert.ok(item);

    const deliverMock = mock.fn(async () => 'msg_nday_002');
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: {
        trigger: mock.fn(() => Promise.reject(new Error('trigger transient failure'))),
      },
    };

    await spec.run.execute(item.signal, item.subjectKey, ctx);

    assert.equal(deliverMock.mock.calls.length, 1, 'deliver was still called (message in thread)');
    const storedVal = redis._store.get('eval-nday-last-dispatch:eval:friction');
    assert.equal(storedVal, undefined, 'Redis must NOT be written when trigger failed');
  });

  it('execute does NOT update Redis when invokeTrigger returns full (cloud R3 P1)', async () => {
    // Cloud R3 P1: trigger returning 'full' (queue at capacity, invocation dropped) must NOT
    // trip the N-day gate. The eval cat was never notified — domain must retry on next probe
    // rather than being silently suppressed for a full N-day window.
    const root = makeTempRoot(FIXTURE_FRICTION_3D_YAML);
    const redis = makeRedis();
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });

    const gateResult = await spec.admission.gate();
    const item = gateResult.workItems.find((w) => w.subjectKey === 'eval:friction');
    assert.ok(item);

    const deliverMock = mock.fn(async () => 'msg_nday_003');
    const ctx = {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: {
        trigger: mock.fn(async () => 'full'), // queue at capacity
      },
    };

    await spec.run.execute(item.signal, item.subjectKey, ctx);

    assert.equal(deliverMock.mock.calls.length, 1, 'deliver was still called (message in thread)');
    const storedVal = redis._store.get('eval-nday-last-dispatch:eval:friction');
    assert.equal(storedVal, undefined, 'Redis must NOT be written when trigger returned full');
  });
});
