/**
 * F139 Phase 2.5: Display Contract Tests (AC-E1 → AC-E5)
 *
 * Tests that:
 * - TaskSpec.display passes through to ScheduleTaskSummary (AC-E1/E2)
 * - subjectPreview is computed from display.subjectKind + lastRun.subject_key (AC-E2)
 * - subjectPreview is null when no lastRun or no subjectKind (AC-E5)
 * - Tasks without display still work (fallback compatibility)
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('F139 Phase 2.5 — Display Contract', () => {
  let db, runner, ledger;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({ logger: silentLogger, ledger });
  });

  afterEach(() => {
    if (runner) runner.stop();
  });

  // ── AC-E1/E2: display passthrough ──

  it('getTaskSummaries includes display when task declares it', () => {
    runner.register({
      id: 'with-display',
      profile: 'poller',
      trigger: { type: 'interval', ms: 60000 },
      admission: { gate: async () => ({ run: false, reason: 'test' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: {
        label: 'CI/CD 检查',
        category: 'pr',
        description: '监控 tracked PR 的 CI 状态变化',
        subjectKind: 'pr',
      },
    });
    const [summary] = runner.getTaskSummaries();
    assert.deepEqual(summary.display, {
      label: 'CI/CD 检查',
      category: 'pr',
      description: '监控 tracked PR 的 CI 状态变化',
      subjectKind: 'pr',
    });
  });

  it('getTaskSummaries returns display undefined when task has no display', () => {
    runner.register({
      id: 'no-display',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 60000 },
      admission: { gate: async () => ({ run: false, reason: 'test' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.display, undefined);
    assert.equal(summary.subjectPreview, null);
  });

  // ── AC-E2: subjectPreview computation ──

  it('subjectPreview computed for PR subject (subjectKind=pr)', async () => {
    runner.register({
      id: 'pr-task',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'pr-owner/repo#42' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: 'Conflict Check', category: 'pr', subjectKind: 'pr' },
    });
    await runner.triggerNow('pr-task');
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, 'owner/repo#42');
  });

  it('subjectPreview computed for thread subject (subjectKind=thread)', async () => {
    runner.register({
      id: 'thread-task',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'thread-abc123def456' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: '记忆压缩', category: 'thread', subjectKind: 'thread' },
    });
    await runner.triggerNow('thread-task');
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, 'Thread abc123de…');
  });

  it('subjectPreview computed for repo subject (subjectKind=repo)', async () => {
    runner.register({
      id: 'repo-task',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'repo:owner/myrepo' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: '仓库巡检', category: 'repo', subjectKind: 'repo' },
    });
    await runner.triggerNow('repo-task');
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, 'owner/myrepo');
  });

  it('subjectPreview is null when no lastRun (AC-E5)', () => {
    runner.register({
      id: 'never-ran',
      profile: 'poller',
      trigger: { type: 'interval', ms: 60000 },
      admission: { gate: async () => ({ run: false, reason: 'test' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: 'Test', category: 'pr', subjectKind: 'pr' },
    });
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, null);
  });

  it('subjectPreview is null when subjectKind is none', async () => {
    runner.register({
      id: 'no-kind',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'something' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: 'System', category: 'system', subjectKind: 'none' },
    });
    await runner.triggerNow('no-kind');
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, null);
  });

  // ── P1-1: SKIP_NO_SIGNAL must not leak task.id as subjectPreview ──

  it('subjectPreview is null after SKIP_NO_SIGNAL (subject_key = task.id)', async () => {
    runner.register({
      id: 'conflict-check',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: { gate: async () => ({ run: false, reason: 'no tracked PRs' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'record' },
      enabled: () => true,
      display: { label: '冲突检测', category: 'pr', subjectKind: 'pr' },
    });
    await runner.triggerNow('conflict-check');
    const [summary] = runner.getTaskSummaries();
    // lastRun.subject_key === 'conflict-check' (task.id), must NOT leak
    assert.equal(summary.subjectPreview, null);
  });

  // ── P1-2: repo-scan real subject format ──

  it('subjectPreview computed for repo-scan real format (repo-owner/repo#pr-N)', async () => {
    runner.register({
      id: 'repo-scan',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'repo-owner/myrepo#pr-42' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: '仓库巡检', category: 'repo', subjectKind: 'repo' },
    });
    await runner.triggerNow('repo-scan');
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, 'owner/myrepo#pr-42');
  });

  it('subjectPreview is null when display has no subjectKind', async () => {
    runner.register({
      id: 'no-subject-kind',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'pr-owner/repo#1' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: { label: 'No Kind', category: 'pr' },
    });
    await runner.triggerNow('no-subject-kind');
    const [summary] = runner.getTaskSummaries();
    assert.equal(summary.subjectPreview, null);
  });

  // --- Task 4: error_summary capture (AC-F3) ---

  it('RUN_FAILED records error_summary in ledger', async () => {
    runner.register({
      id: 'error-summary-test',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'boom', subjectKey: 'test-key' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          throw new Error('something broke badly');
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    await runner.triggerNow('error-summary-test');
    const runs = ledger.query('error-summary-test', 1);
    assert.equal(runs[0].outcome, 'RUN_FAILED');
    assert.ok(runs[0].error_summary, 'error_summary should be populated');
    assert.match(runs[0].error_summary, /something broke badly/);
  });

  it('RUN_DELIVERED has null error_summary', async () => {
    runner.register({
      id: 'success-summary-test',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'ok', subjectKey: 'test-key' }],
        }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    await runner.triggerNow('success-summary-test');
    const runs = ledger.query('success-summary-test', 1);
    assert.equal(runs[0].outcome, 'RUN_DELIVERED');
    assert.equal(runs[0].error_summary, null);
  });
});
