/**
 * F245 PR2 — N-day cadence + last-run gate tests.
 *
 * Tests createEvalDomainNDaySpec:
 *  - TaskSpec shape (id / trigger / profile / state)
 *  - Gate: Redis null → fail-open (domain included)
 *  - Gate: no Redis injected → fail-open
 *  - Gate: last-dispatch < N days ago → skip (cadence not due)
 *  - Gate: last-dispatch > N days ago → include
 *
 * Execute tests split to eval-domain-nday-execute.test.js (cloud R4 P1: file-size limit).
 * Shared fixtures/helpers in eval-domain-nday-fixtures.js.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';
import {
  DAY_MS,
  FIXTURE_3D_WITH_LEGACY_YAML,
  FIXTURE_3D_YAML,
  FIXTURE_7D_YAML,
  makeRedis,
  makeTempRoot,
} from './eval-domain-nday-fixtures.js';

// ---- Tests ----

describe('createEvalDomainNDaySpec — TaskSpec shape', () => {
  it('returns a valid TaskSpec_P1 with id=eval-domain-nday, daily cron, awareness profile', () => {
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: '/nonexistent' });

    assert.equal(spec.id, 'eval-domain-nday');
    assert.equal(spec.profile, 'awareness');
    assert.deepEqual(spec.trigger, { type: 'cron', expression: '0 3 * * *', timezone: 'UTC' });
    assert.equal(spec.run.overlap, 'skip');
    assert.equal(spec.run.timeoutMs, 60_000);
    assert.deepEqual(spec.state, { runLedger: 'sqlite' });
    assert.deepEqual(spec.outcome, { whenNoSignal: 'drop' });
    assert.equal(spec.enabled(), true);
    assert.equal(spec.display.label, 'N天周期 Harness Eval');
    assert.equal(spec.display.category, 'system');
  });
});

describe('createEvalDomainNDaySpec — gate', () => {
  it('gate returns run=false when no N-day domains exist (nonexistent root)', async () => {
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: '/nonexistent/path' });
    const result = await spec.admission.gate();
    assert.equal(result.run, false);
    assert.equal(result.reason, 'no registered eval domains');
  });

  it('gate includes every-3d domain when no Redis is provided (fail-open)', async () => {
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root });
    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'gate should run with N-day domains present');
    const item = result.workItems.find((w) => w.subjectKey === 'eval:test-friction');
    assert.ok(item, 'every-3d domain must be included when no Redis (fail-open)');
  });

  it('gate includes every-3d domain when Redis has no last-dispatch entry (null)', async () => {
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const redis = makeRedis(); // empty → null on get
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    const item = result.workItems.find((w) => w.subjectKey === 'eval:test-friction');
    assert.ok(item, 'every-3d domain with no Redis entry must be included');
  });

  it('gate skips every-3d domain when last-dispatch is 2.5 days ago', async () => {
    const lastDispatch = (Date.now() - 2.5 * DAY_MS).toString();
    const redis = makeRedis({
      'eval-nday-last-dispatch:eval:test-friction': lastDispatch,
    });
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    const item = result.workItems?.find((w) => w.subjectKey === 'eval:test-friction');
    assert.equal(item, undefined, 'every-3d domain must be SKIPPED: 2.5d < 3d cadence');
  });

  it('gate includes every-3d domain when last-dispatch is 4 days ago', async () => {
    const lastDispatch = (Date.now() - 4 * DAY_MS).toString();
    const redis = makeRedis({
      'eval-nday-last-dispatch:eval:test-friction': lastDispatch,
    });
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    const item = result.workItems.find((w) => w.subjectKey === 'eval:test-friction');
    assert.ok(item, 'every-3d domain with 4-day-old dispatch must be included (4d >= 3d)');
  });

  it('gate skips every-7d domain when last-dispatch is 6 days ago', async () => {
    const lastDispatch = (Date.now() - 6 * DAY_MS).toString();
    const redis = makeRedis({
      'eval-nday-last-dispatch:eval:test-sop': lastDispatch,
    });
    const root = makeTempRoot(FIXTURE_7D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    const item = result.workItems?.find((w) => w.subjectKey === 'eval:test-sop');
    assert.equal(item, undefined, 'every-7d domain must be SKIPPED: 6d < 7d cadence');
  });

  it('gate includes every-7d domain when last-dispatch is 8 days ago', async () => {
    const lastDispatch = (Date.now() - 8 * DAY_MS).toString();
    const redis = makeRedis({
      'eval-nday-last-dispatch:eval:test-sop': lastDispatch,
    });
    const root = makeTempRoot(FIXTURE_7D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    const item = result.workItems.find((w) => w.subjectKey === 'eval:test-sop');
    assert.ok(item, 'every-7d domain with 8-day-old dispatch must be included (8d >= 7d)');
  });

  it('gate handles two mixed N-day domains: due one included, not-due one skipped', async () => {
    const root = makeTempRoot(FIXTURE_3D_YAML, FIXTURE_7D_YAML);
    // 3d domain: 4 days ago → due
    // 7d domain: 6 days ago → not due
    const redis = makeRedis({
      'eval-nday-last-dispatch:eval:test-friction': (Date.now() - 4 * DAY_MS).toString(),
      'eval-nday-last-dispatch:eval:test-sop': (Date.now() - 6 * DAY_MS).toString(),
    });
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'gate runs because at least one domain is due');
    assert.equal(result.workItems.length, 1, 'exactly one domain due');
    assert.equal(result.workItems[0].subjectKey, 'eval:test-friction');
  });

  // Cloud R1 P2-1 regression: timing-jitter tolerance
  it('gate includes every-3d domain when last-dispatch is 3d minus 30s ago (CRON_JITTER_MS tolerance)', async () => {
    // Simulates: cron fires at 03:00:00 on day D, Redis write completes 30 s later (03:00:30).
    // Next probe fires at 03:00:00 on day D+3: elapsed = 3*DAY_MS - 30s, which is 30s short
    // of the exact 3*DAY_MS threshold. Without CRON_JITTER_MS this would slip to day D+4.
    const lastDispatch = (Date.now() - (3 * DAY_MS - 30_000)).toString();
    const redis = makeRedis({ 'eval-nday-last-dispatch:eval:test-friction': lastDispatch });
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true);
    const item = result.workItems?.find((w) => w.subjectKey === 'eval:test-friction');
    assert.ok(item, 'domain must be included when elapsed = 3d - 30s (within 2-min CRON_JITTER_MS tolerance)');
  });

  // Cloud R1 P2-2 regression: legacy-task double-trigger gate
  it('gate skips every-3d domain when its legacy task is still enabled (cloud R1 P2)', async () => {
    // Domain has legacyScheduledTaskIds: ['legacy-fit-digest']. If that task is still enabled,
    // both the N-day cron AND the legacy task would fire — gate must exclude the domain.
    const root = makeTempRoot(FIXTURE_3D_WITH_LEGACY_YAML);
    const spec = createEvalDomainNDaySpec({
      harnessFeedbackRoot: root,
      listDynamicTasks: () => [{ id: 'legacy-fit-digest', templateId: 'reminder', enabled: true }],
    });
    const result = await spec.admission.gate();

    assert.equal(result.run, false, 'gate must not run when all N-day domains have active legacy tasks');
    assert.equal(result.reason, 'all N-day domains skipped — cadence not due or active legacy tasks');
  });

  it('gate includes every-3d domain when its legacy task is disabled (cloud R1 P2)', async () => {
    // Same fixture but legacy task is disabled → no double-trigger risk → domain is eligible.
    const root = makeTempRoot(FIXTURE_3D_WITH_LEGACY_YAML);
    const spec = createEvalDomainNDaySpec({
      harnessFeedbackRoot: root,
      listDynamicTasks: () => [{ id: 'legacy-fit-digest', templateId: 'reminder', enabled: false }],
    });
    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'gate must run when legacy task is disabled');
    const item = result.workItems?.find((w) => w.subjectKey === 'eval:test-friction-legacy');
    assert.ok(item, 'domain must be in workItems when legacy task is disabled');
  });

  // Cloud R2 P2: malformed / non-numeric Redis last-dispatch → fail-open (retry next probe)
  it('gate includes every-3d domain when Redis last-dispatch value is non-numeric (NaN fail-open)', async () => {
    // Simulates a corrupt or manually-set Redis value that parseInt() cannot parse.
    // Without Number.isFinite() guard: parseInt('corrupt', 10) = NaN,
    // NaN >= threshold is always false, domain is permanently skipped.
    // With fix: NaN → treated as missing key → isDue stays true → domain retried next cron.
    const redis = makeRedis({ 'eval-nday-last-dispatch:eval:test-friction': 'corrupt-value' });
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'gate must fail-open for non-numeric last-dispatch values');
    const item = result.workItems?.find((w) => w.subjectKey === 'eval:test-friction');
    assert.ok(item, 'domain must be included when last-dispatch is non-numeric');
  });

  it('gate includes every-3d domain when Redis last-dispatch value is empty string (NaN fail-open)', async () => {
    // parseInt('', 10) returns NaN — same edge case with empty string.
    const redis = makeRedis({ 'eval-nday-last-dispatch:eval:test-friction': '' });
    const root = makeTempRoot(FIXTURE_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis });
    const result = await spec.admission.gate();

    assert.equal(result.run, true, 'gate must fail-open for empty-string last-dispatch values');
    const item = result.workItems?.find((w) => w.subjectKey === 'eval:test-friction');
    assert.ok(item, 'domain must be included when last-dispatch is empty string');
  });
});
