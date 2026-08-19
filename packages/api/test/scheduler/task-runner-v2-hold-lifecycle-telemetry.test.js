import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

const { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

const otelExporter = new InMemorySpanExporter();
const otelProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(otelExporter)],
});
otelProvider.register();

describe('TaskRunnerV2 hold lifecycle telemetry', () => {
  let db;
  let runner;
  let ledger;
  let dynamicTaskStore;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { DynamicTaskStore } = await import('../../dist/infrastructure/scheduler/DynamicTaskStore.js');
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
    dynamicTaskStore = new DynamicTaskStore(db);
    runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });
    otelExporter.reset();
  });

  afterEach(() => {
    if (runner) runner.stop();
    db?.close();
  });

  const makeOnceTask = (id, fireAt, overrides = {}) => ({
    id,
    profile: 'awareness',
    trigger: { type: 'once', fireAt },
    admission: { gate: async () => ({ run: true, workItems: [{ signal: 'x', subjectKey: id }] }) },
    run: {
      overlap: 'skip',
      timeoutMs: 5000,
      execute: async () => {},
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: { label: id, category: 'system' },
    ...overrides,
  });

  it('does not emit expired-after-satisfied sample for the healthy suppressed tombstone path', async () => {
    const fireAt = Date.now() + 50;

    dynamicTaskStore.insert({
      id: 'hold-ball-retired-healthy',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt },
      params: {
        message: 'should not wake',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'review_posted',
          wakeAt: fireAt,
          createdBy: 'hold-ball:codex',
          resolvedBy: {
            sourceKind: 'review_feedback',
            sourceMessageId: 'msg-review-1',
            subjectKey: 'pr:owner/repo#42',
            expectedSignalKey: 'review_posted',
            at: Date.now(),
          },
        },
      },
      display: { label: '持球唤醒 (codex)', category: 'system' },
      deliveryThreadId: 'thread-retired-regression',
      enabled: false,
      createdBy: 'hold-ball:codex',
      createdAt: new Date().toISOString(),
    });

    runner.registerDynamic(makeOnceTask('hold-ball-retired-healthy', fireAt), 'hold-ball-retired-healthy');
    runner.start();
    await new Promise((r) => setTimeout(r, 200));

    const spans = otelExporter.getFinishedSpans();
    const sampleSpans = spans.filter((s) => s.name === 'cat_cafe.a2a.hold_lifecycle.expired_after_satisfied_sample');
    assert.equal(sampleSpans.length, 0, 'healthy stale-wake suppression must not become an AC-Q7 regression');
    assert.ok(!runner.getRegisteredTasks().includes('hold-ball-retired-healthy'), 'retired hold still leaves runtime');
  });

  it('emits expired-after-satisfied sample when a retired hold remains enabled at fireAt', async () => {
    const fireAt = Date.now() + 50;

    dynamicTaskStore.insert({
      id: 'hold-ball-retired-regression',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt },
      params: {
        message: 'should not wake',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'review_posted',
          wakeAt: fireAt,
          createdBy: 'hold-ball:codex',
          resolvedBy: {
            sourceKind: 'review_feedback',
            sourceMessageId: 'msg-review-1',
            subjectKey: 'pr:owner/repo#42',
            expectedSignalKey: 'review_posted',
            at: Date.now(),
          },
        },
      },
      display: { label: '持球唤醒 (codex)', category: 'system' },
      deliveryThreadId: 'thread-retired-regression',
      enabled: true,
      createdBy: 'hold-ball:codex',
      createdAt: new Date().toISOString(),
    });

    runner.registerDynamic(makeOnceTask('hold-ball-retired-regression', fireAt), 'hold-ball-retired-regression');
    runner.start();
    await new Promise((r) => setTimeout(r, 200));

    const spans = otelExporter.getFinishedSpans();
    const sampleSpan = spans.find((s) => s.name === 'cat_cafe.a2a.hold_lifecycle.expired_after_satisfied_sample');
    assert.ok(
      sampleSpan,
      `must emit expired-after-satisfied sample span; got names: ${JSON.stringify(spans.map((s) => s.name))}`,
    );
    assert.equal(sampleSpan.events.length, 1);
    const event = sampleSpan.events[0];
    assert.equal(event.name, 'hold_lifecycle.expired_after_satisfied_fired');
    assert.equal(event.attributes.messageId, 'hold-ball-retired-regression');
    assert.equal(event.attributes.threadId, 'thread-retired-regression');
    assert.equal(event.attributes['agent.id'], 'codex');
    assert.equal(event.attributes.trigger, 'timer_expired_after_event');
    assert.equal(event.attributes.taskIdHash.length > 0, true);
    assert.equal(event.attributes.subjectKey, undefined);
    assert.equal(event.attributes.subjectKeyHash.length > 0, true);
    assert.notEqual(event.attributes.subjectKeyHash, 'pr:owner/repo#42');
    assert.equal(event.attributes.expectedSignalKey, 'review_posted');
    assert.equal(event.attributes.sourceKind, 'review_feedback');
  });

  it('does not throw when best-effort hash telemetry has no salt', () => {
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.TELEMETRY_HMAC_SALT;
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import { emitHoldExpiredAfterSatisfied } from './dist/infrastructure/scheduler/hold-lifecycle-telemetry.js';
            emitHoldExpiredAfterSatisfied({
              id: 'hold-ball-retired-regression',
              templateId: 'reminder',
              trigger: { type: 'once', fireAt: Date.now() },
              params: {
                message: 'should not wake',
                holdLifecycle: {
                  mode: 'timer',
                  status: 'retired_by_event',
                  subjectKey: 'pr:private/repo#42',
                  expectedSignalKey: 'review_posted',
                  wakeAt: Date.now(),
                  createdBy: 'hold-ball:codex',
                  resolvedBy: {
                    sourceKind: 'review_feedback',
                    sourceMessageId: 'msg-review-1',
                    subjectKey: 'pr:private/repo#42',
                    expectedSignalKey: 'review_posted',
                    at: Date.now(),
                  },
                },
              },
              display: { label: 'hold wake', category: 'system' },
              deliveryThreadId: 'thread-retired-regression',
              enabled: true,
              createdBy: 'hold-ball:codex',
              createdAt: new Date().toISOString(),
            });
          `,
        ],
        { cwd: process.cwd(), env, stdio: 'pipe' },
      );
    });
  });
});
