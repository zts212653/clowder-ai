import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEvalDomainDailySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';
import {
  createTelemetryEvidencePrereqProbe,
  evaluateEvidencePrereq,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-evidence-gate.js';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

/**
 * Evidence-source prereq gate (eval:a2a build verdict
 * `2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build`, PR #19).
 *
 * Bug class: the scheduled eval fires on a runtime whose OTel telemetry is
 * disabled (TELEMETRY_HMAC_SALT unset → initTelemetry() returned null handles).
 * The `f167-runtime-eval` source cannot produce fresh snapshots, yet the eval
 * cat is invoked anyway and burns a full LLM session to re-conclude "telemetry
 * still disabled" — every day (2026-06-30 → 2026-07-07 verdict series). The
 * gate fails closed BEFORE invocation and posts a zero-LLM-cost skip notice
 * to the domain's own system thread instead.
 */
describe('eval-domain evidence-source prereq gate (eval:a2a PR #19)', () => {
  const mkCtx = () => {
    const deliverMock = mock.fn(async () => 'msg_evidence');
    const triggerMock = mock.fn();
    return {
      deliverMock,
      triggerMock,
      ctx: { assignedCatId: null, deliver: deliverMock, invokeTrigger: { trigger: triggerMock } },
    };
  };

  describe('createTelemetryEvidencePrereqProbe', () => {
    it('telemetry-backed adapter + OTel disabled → not ok, reason points at salt', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => false });
      const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
      assert.equal(result.ok, false);
      assert.ok(
        result.reason.includes('TELEMETRY_HMAC_SALT'),
        `default reason must name the missing salt env var (got: ${result.reason})`,
      );
    });

    it('telemetry-backed adapter + OTel enabled → ok', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => true });
      const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
      assert.equal(result.ok, true);
    });

    it('non-telemetry adapter passes through even when OTel is disabled', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => false });
      const result = probe({ domainId: 'eval:sop', sourceAdapter: 'sop-trace-eval' });
      assert.equal(result.ok, true, 'gate must only constrain telemetry-backed source adapters');
    });

    it('OTEL_SDK_DISABLED=true → reason names the env toggle, not the salt', () => {
      const prev = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'true';
      try {
        const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => false });
        const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
        assert.equal(result.ok, false);
        assert.ok(result.reason.includes('OTEL_SDK_DISABLED'), `got: ${result.reason}`);
      } finally {
        if (prev === undefined) delete process.env.OTEL_SDK_DISABLED;
        else process.env.OTEL_SDK_DISABLED = prev;
      }
    });
  });

  it('bootstrap wires the telemetry init state into every scheduled eval spec', () => {
    const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

    assert.match(indexSource, /createTelemetryEvidencePrereqProbe/);
    assert.match(
      indexSource,
      /otelEnabled:\s*\(\)\s*=>\s*telemetryHandle\.getMetricsText\s*!==\s*null/,
      'the probe must observe the actual boot-time telemetry handle, not an env proxy',
    );
    assert.match(
      indexSource,
      /const evalScheduleOpts = \{[\s\S]*?evidencePrereqProbe,[\s\S]*?\};/,
      'shared daily, weekly, and N-day schedule options must include the evidence probe',
    );
  });

  describe('evaluateEvidencePrereq', () => {
    it('probe throw → fail-closed not-ok with reason', async () => {
      const result = await evaluateEvidencePrereq(
        () => {
          throw new Error('synthetic evidence probe failure');
        },
        { domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      );
      assert.equal(result.ok, false);
      assert.ok(result.reason.includes('synthetic evidence probe failure'));
    });
  });

  describe('daily spec integration', () => {
    async function getA2aItem(spec) {
      const gateResult = await spec.admission.gate();
      const item = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
      assert.ok(item, 'eval:a2a must be a registered daily domain');
      return item;
    }

    it('probe not-ok → SKIPPED notice in domain thread, cat never invoked', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: false, reason: 'OTel disabled at boot: HMAC salt validation failed' }),
      });
      const item = await getA2aItem(spec);
      const { deliverMock, triggerMock, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 0, 'trigger must NOT fire when evidence source is down');
      assert.equal(deliverMock.mock.callCount(), 1);
      const call = deliverMock.mock.calls[0].arguments[0];
      assert.equal(call.threadId, 'thread_eval_a2a', 'skip notice must stay in the domain system thread');
      assert.equal(call.userId, 'scheduler');
      assert.ok(call.content.includes('SKIPPED (evidence source unavailable)'), 'stable header for grep/dedup');
      assert.ok(call.content.includes('HMAC salt validation failed'), 'notice must carry the probe reason');
      assert.ok(call.content.includes('TELEMETRY_HMAC_SALT'), 'notice must state the actionable next step');
    });

    it('probe ok → normal invocation proceeds', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: true }),
      });
      const item = await getA2aItem(spec);
      const { deliverMock, triggerMock, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 1, 'trigger fires when evidence source is healthy');
      assert.equal(deliverMock.mock.callCount(), 1);
      assert.ok(!deliverMock.mock.calls[0].arguments[0].content.includes('SKIPPED'));
    });

    it('probe throws → fail-closed skip, no crash, no LLM call', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => {
          throw new Error('synthetic gate crash');
        },
      });
      const item = await getA2aItem(spec);
      const { deliverMock, triggerMock, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 0);
      assert.equal(deliverMock.mock.callCount(), 1);
      assert.ok(deliverMock.mock.calls[0].arguments[0].content.includes('SKIPPED (evidence source unavailable)'));
    });

    it('both gates failing → evidence-source message wins (upstream-first ordering)', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: false, reason: 'OTel disabled at boot' }),
        publishPrereqProbe: () => false,
      });
      const item = await getA2aItem(spec);
      const { deliverMock, triggerMock, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 0);
      assert.equal(deliverMock.mock.callCount(), 1, 'exactly one skip notice, not two');
      const content = deliverMock.mock.calls[0].arguments[0].content;
      assert.ok(content.includes('evidence source unavailable'), 'evidence gate runs before publish gate');
      assert.ok(!content.includes('publish prereq missing'));
    });

    it('evidence probe ok + publish gate still enforced → publish skip preserved', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: true }),
        publishPrereqProbe: () => false,
      });
      const item = await getA2aItem(spec);
      const { deliverMock, triggerMock, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 0);
      assert.equal(deliverMock.mock.callCount(), 1);
      assert.ok(deliverMock.mock.calls[0].arguments[0].content.includes('publish prereq missing'));
    });
  });

  describe('nday spec integration', () => {
    it('probe not-ok → skip notice, no trigger, no Redis last-dispatch write', async () => {
      const redisSet = mock.fn(async () => 'OK');
      const redis = { get: mock.fn(async () => null), set: redisSet };
      const spec = createEvalDomainNDaySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        redis,
        evidencePrereqProbe: () => ({ ok: false, reason: 'OTel disabled at boot' }),
      });

      const gateResult = await spec.admission.gate();
      assert.equal(gateResult.run, true, 'registry must contain at least one N-day domain');
      const item = gateResult.workItems[0];
      const { deliverMock, triggerMock, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(triggerMock.mock.callCount(), 0, 'trigger must NOT fire when evidence source is down');
      assert.equal(deliverMock.mock.callCount(), 1);
      const call = deliverMock.mock.calls[0].arguments[0];
      assert.equal(call.threadId, item.signal.systemThreadId);
      assert.ok(call.content.includes('SKIPPED (evidence source unavailable)'));
      assert.equal(
        redisSet.mock.callCount(),
        0,
        'skip must NOT consume the N-day window — domain retries on next daily probe',
      );
    });
  });
});
