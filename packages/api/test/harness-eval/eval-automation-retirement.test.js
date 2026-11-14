import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import {
  dispatchEvolutionProgramRoundTrigger,
  loadEvolutionProgramTriggerRegistration,
} from '../../dist/infrastructure/capability-evolution/program-trigger-bridge.js';
import {
  createEvalDomainDailySpec,
  createEvalDomainWeeklySpec,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';
import { parseEvalDomainRegistryFile } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import { dispatchEvalDomainTrigger } from '../../dist/infrastructure/harness-eval/domain/eval-domain-trigger-dispatch.js';
import { buildEvalCatInvocation } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createReevalClosureTaskSpec } from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';

const root = new URL('../../../../docs/harness-feedback/', import.meta.url).pathname;
const retirement = /自动.*停用|自动.*退役|automatic.*retired/i;
const unexpected = async () => {
  throw new Error('Retired automation touched a live dependency');
};

it('real scheduler due ticks, manual overrides and restart cannot resume retired automation', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-11-13T02:59:59Z') });
  const db = new Database(':memory:');
  applyMigrations(db);
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      const runner = new TaskRunnerV2({
        logger: { info() {}, error: unexpected },
        ledger: new RunLedger(db),
        deliver: unexpected,
      });
      for (const factory of [createEvalDomainDailySpec, createEvalDomainWeeklySpec, createEvalDomainNDaySpec]) {
        runner.register(factory({ harnessFeedbackRoot: root }));
      }
      runner.register(
        createReevalClosureTaskSpec({
          eventLog: { read: unexpected, append: unexpected },
          loadSubjects: unexpected,
          log: { info() {}, warn() {} },
        }),
      );
      try {
        runner.start();
        t.mock.timers.tick(600_001);
        await runner.checkCronMisfires(Date.parse('2026-11-22T03:00:00Z'));
        for (const id of runner.getRegisteredTasks()) await runner.triggerNow(id, { manual: true });
        for (const summary of runner.getTaskSummaries()) {
          assert.equal(summary.effectiveEnabled, false);
          assert.match(summary.display.description, retirement);
        }
      } finally {
        runner.stop();
      }
    }
  } finally {
    db.close();
  }
});
// A scheduler override or an admitted signal from before restart must not recreate work.
for (const factory of [createEvalDomainDailySpec, createEvalDomainWeeklySpec, createEvalDomainNDaySpec]) {
  it(`${factory.name}: due, forced, late and restarted runs leave no side effects`, async () => {
    for (let restart = 0; restart < 2; restart += 1) {
      const spec = factory({
        harnessFeedbackRoot: root,
        listDynamicTasks: () => {
          throw new Error('read dynamic tasks');
        },
      });
      assert.equal(spec.enabled(), false);
      const gate = await spec.admission.gate({});
      assert.equal(gate.run, false);
      assert.match('reason' in gate ? gate.reason : '', retirement);
      await spec.run.execute({ domainId: 'eval:a2a' }, 'eval:a2a', { deliver: unexpected });
    }
  });
}
it('F266 never creates a new repair/reevaluation from a due or previously admitted batch', async () => {
  for (let restart = 0; restart < 2; restart += 1) {
    const spec = createReevalClosureTaskSpec({
      eventLog: { read: unexpected, append: unexpected },
      loadSubjects: unexpected,
      responsibilityService: { reconcile: unexpected },
      reevaluationService: { needsReconcile: unexpected, reconcile: unexpected },
      log: { info() {}, warn() {} },
    });
    assert.equal(spec.enabled(), false);
    const gate = await spec.admission.gate({});
    assert.equal(gate.run, false);
    assert.match('reason' in gate ? gate.reason : '', retirement);
    await spec.run.execute({ planned: [{}], bindResponsibility: true, bindReevaluation: true }, 'case:old', {});
  }
});
it('threshold events, duplicates and late deliveries cannot claim receipts or wake a cat', async () => {
  const domain = parseEvalDomainRegistryFile(
    parseYaml(readFileSync(join(root, 'eval-domains/eval-capability-evolution.yaml'), 'utf8')),
  );
  const invocation = buildEvalCatInvocation({
    domain,
    trendRefs: [],
    verdictRefs: [],
    legacyCleanup: { status: 'disabled' },
  });
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const result = await dispatchEvalDomainTrigger({
      domain,
      invocation,
      channel: 'threshold_event',
      triggerReason: 'late owner-surface event',
      event: {
        eventId: 'same-event',
        eventSource: 'evolution-program-stream',
        counter: 'connectedOwnerSurfaces',
        previousValue: 1,
        currentValue: 2,
      },
      store: { claim: unexpected, complete: unexpected, release: unexpected },
      deliver: unexpected,
    });
    assert.equal(result.outcome, 'automation_retired');
  }
});
it('Hub reports automation disabled and keeps historical verdicts readable', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'eval-retired-'));
  try {
    mkdirSync(join(fixture, 'eval-domains'));
    mkdirSync(join(fixture, 'verdicts'));
    writeFileSync(join(fixture, 'eval-domains/eval-a2a.yaml'), readFileSync(join(root, 'eval-domains/eval-a2a.yaml')));
    const summary = loadEvalHubSummary({ harnessFeedbackRoot: fixture });
    assert.equal(summary.domains[0]?.enabled, false);
    assert.equal(summary.domains[0]?.nextCronFireAt, undefined);
    assert.equal(summary.domains[0]?.automaticStatus, 'retired');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
it('Program registration preserves the on-demand bridge without promising a future automatic round', () => {
  const registration = loadEvolutionProgramTriggerRegistration({ harnessFeedbackRoot: root });
  assert.ok(registration?.registrationRef);
  assert.equal(registration.automaticStatus, 'retired');
  assert.deepEqual(registration.channels, ['on_demand']);
  assert.equal(registration.nextEvaluationAt, undefined);
});
it('an explicitly requested F311 round still admits once and dedupes after a bridge restart', async () => {
  const claims = new Set();
  const delivered = [];
  const store = {
    async claim(input) {
      const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
      if (claims.has(key)) return { outcome: 'deduped' };
      claims.add(key);
      return { outcome: 'claimed' };
    },
    async complete() {
      return true;
    },
    async release() {},
  };
  const input = {
    harnessFeedbackRoot: root,
    programId: 'existing-program',
    store,
    nowMs: Date.parse('2026-11-13T15:00:00Z'),
    deliver: async (message) => {
      delivered.push(message);
      return 'round-source';
    },
  };
  assert.equal((await dispatchEvolutionProgramRoundTrigger(input)).outcome, 'dispatched');
  assert.equal((await dispatchEvolutionProgramRoundTrigger({ ...input })).outcome, 'deduped');
  assert.equal(delivered.length, 1);
});
