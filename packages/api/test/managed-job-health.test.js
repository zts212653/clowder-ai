import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeManagedJobHealth } from '../dist/domains/managed-job/managed-job-health.js';

test('job health separates queue time, execution, log volume and duplicate attempts', () => {
  const history = [
    { createdAt: 100, updatedAt: 100, state: 'queued' },
    { createdAt: 100, updatedAt: 350, state: 'running', attemptToken: 'first' },
    { createdAt: 100, updatedAt: 400, state: 'running', attemptToken: 'first' },
    { createdAt: 100, updatedAt: 500, state: 'running', attemptToken: 'second' },
    {
      createdAt: 100,
      updatedAt: 900,
      state: 'terminal',
      terminalStatus: 'failed',
      attemptToken: 'second',
      result: { durationMs: 550, log: { bytes: 8192 } },
    },
  ];
  const health = summarizeManagedJobHealth(history, 'terminal', 2000);
  assert.equal(health.queueDurationMs, 250);
  assert.equal(health.runtimeDurationMs, 550);
  assert.equal(health.logBytes, 8192);
  assert.equal(health.duplicateAttempts, 1);
  assert.equal(health.state, 'failed');
  assert.equal(health.unresolvedExecution, false);
});

test('pending process evidence is exposed as unresolved, never declared orphan-free', () => {
  const history = [{ createdAt: 100, updatedAt: 200, state: 'running', attemptToken: 'first', cleanupProven: false }];
  assert.equal(summarizeManagedJobHealth(history, 'pending', 500).unresolvedExecution, true);
  assert.equal(summarizeManagedJobHealth(history, 'adopted', 500).unresolvedExecution, false);
  assert.equal(summarizeManagedJobHealth(history, 'pending', 500).queueDurationMs, 100);
});

test('authorized recovery attempts are distinct from duplicate children in the same pause epoch', () => {
  const history = [
    { state: 'running', attemptToken: 'first', attemptResumeEpoch: 0 },
    { state: 'running', attemptToken: 'second', attemptResumeEpoch: 1 },
  ];
  assert.equal(summarizeManagedJobHealth(history, 'adopted', 500).duplicateAttempts, 0);
  history.push({ state: 'running', attemptToken: 'duplicate', attemptResumeEpoch: 1 });
  assert.equal(summarizeManagedJobHealth(history, 'adopted', 500).duplicateAttempts, 1);
});

test('user-message cancellation remains a visible invariant violation', () => {
  const history = [
    {
      createdAt: 100,
      updatedAt: 500,
      state: 'terminal',
      terminalStatus: 'cancelled',
      cancel: { reason: 'user_message' },
      result: { durationMs: 400 },
    },
  ];
  assert.equal(summarizeManagedJobHealth(history, 'terminal', 1000).userMessageCancellation, true);
  assert.equal(summarizeManagedJobHealth([], 'pending', 1000).state, 'unknown');
  assert.equal(
    summarizeManagedJobHealth(history, 'terminal', 1000).queueDurationMs,
    null,
    'legacy snapshots without a start event do not invent queue latency',
  );
});
